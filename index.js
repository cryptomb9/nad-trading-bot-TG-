import { Telegraf, Markup } from "telegraf";
import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";
import cron from "node-cron";

import erc20Abi from "./abis/erc20.json" with { type: "json" };
import bondingCurveRouterAbi from "./abis/bundingcurverouter.json" with { type: "json" };
import bondingCurveAbi from "./abis/bundingcurve.json" with { type: "json" };
import dexRouterAbi from "./abis/dexrouter.json" with { type: "json" };
import tokenAbi from "./abis/token.json" with { type: "json" };

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

import { getWallet as dbGetWallet, saveWallet as dbSaveWallet } from "./db.js";

const CONTRACTS = {
  BONDING_CURVE: "0x52D34d8536350Cd997bCBD0b9E9d722452f341F5",
  BONDING_CURVE_ROUTER: "0x4F5A3518F082275edf59026f72B66AC2838c0414",
  DEX_ROUTER: "0x4FBDC27FAE5f99E7B09590bEc8Bf20481FCf9551",
  FACTORY: "0x961235a9020B05C44DF1026D956D1F4D78014276",
  WMON: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701"
};

const API_BASE = "https://testnet-v3-api.nad.fun";
const WS_BASE = "wss://testnet-v3-ws.nad.fun/wss";
const EXPLORER_BASE = "https://testnet.monadexplorer.com/tx";

let authenticatedUsers = new Set();
let pendingActions = new Map();

function formatPrice(price) {
  const num = parseFloat(price);
  if (num === 0) return "0.000";
  if (num >= 1) return num.toFixed(3);
  if (num >= 0.001) return num.toFixed(6);
  return num.toFixed(9);
}

function formatTokenAmount(amount, decimals = 18) {
  const formatted = ethers.formatUnits(amount, decimals);
  return parseFloat(formatted).toLocaleString();
}

function formatMcap(mcap) {
  const num = parseFloat(mcap);
  if (num >= 1000000) return `$${(num/1000000).toFixed(2)}M`;
  if (num >= 1000) return `$${(num/1000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

function formatInterval(minutes) {
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0 && hours > 0) return `${days}d ${hours}h`;
    if (days > 0 && mins > 0) return `${days}d ${mins}m`;
    if (days > 0) return `${days}d`;
    return `${hours}h ${mins}m`;
  } else if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins > 0) return `${hours}h ${mins}m`;
    return `${hours}h`;
  } else {
    return `${minutes}m`;
  }
}

function createTxLink(hash) {
  return `[${hash.substring(0, 12)}...](${EXPLORER_BASE}/${hash})`;
}

function createMainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💰 Wallet", "wallet"), Markup.button.callback("📊 Positions", "positions")],
    [Markup.button.callback("⚙️ Settings", "settings"), Markup.button.callback("📈 Buy", "buy_menu")],
    [Markup.button.callback("📉 Sell", "sell_menu"), Markup.button.callback("🤖 Auto Features", "auto_features")],
    [Markup.button.callback("🔍 Token Info", "token_info"), Markup.button.callback("🔄 Refresh", "refresh")]
  ]);
}

function createAutoFeaturesKeyboard(user) {
  const autobuyStatus = user.autoBuy ? "ON ✅" : "OFF ❌";
  const autosellStatus = user.autoSell?.enabled ? "ON ✅" : "OFF ❌";
  const dcaStatus = user.dcaCampaigns?.length > 0 ? `${user.dcaCampaigns.length} Active` : "None";
  
  return Markup.inlineKeyboard([
    [Markup.button.callback(`⚡ Auto-buy: ${autobuyStatus}`, "toggle_autobuy")],
    [Markup.button.callback(`🎯 Auto-sell: ${autosellStatus}`, "autosell_menu")],
    [Markup.button.callback(`📈 DCA: ${dcaStatus}`, "dca_menu")],
    [Markup.button.callback("« Back", "main_menu")]
  ]);
}

function createDCAKeyboard(campaigns) {
  const buttons = [];
  
  if (campaigns && campaigns.length > 0) {
    for (let i = 0; i < campaigns.length; i++) {
      const campaign = campaigns[i];
      const status = campaign.active ? "🟢" : "🔴";
      const intervalText = formatInterval(campaign.intervalMinutes);
      buttons.push([Markup.button.callback(`${status} ${campaign.tokenSymbol || campaign.tokenAddress.substring(0, 8)} (${intervalText})`, `dca_view_${i}`)]);
    }
  }
  
  buttons.push([Markup.button.callback("➕ New DCA", "dca_new")]);
  buttons.push([Markup.button.callback("« Back", "auto_features")]);
  
  return Markup.inlineKeyboard(buttons);
}

function createAutosellKeyboard(user) {
  const enabled = user.autoSell?.enabled || false;
  
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${enabled ? "🔴 Disable" : "🟢 Enable"}`, "toggle_autosell")],
    [Markup.button.callback("🎯 Market Cap Targets", "autosell_mcap")],
    [Markup.button.callback("📊 Profit/Loss Targets", "autosell_pnl")],
    [Markup.button.callback("⏰ Time-based Sells", "autosell_time")],
    [Markup.button.callback("« Back", "auto_features")]
  ]);
}

function createWalletKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💸 Deposit", "deposit"), Markup.button.callback("💰 Balance", "balance")],
    [Markup.button.callback("🔑 Export Key", "export"), Markup.button.callback("🔄 Refresh", "refresh_wallet")],
    [Markup.button.callback("« Back", "main_menu")]
  ]);
}

function createSettingsKeyboard(user) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`⚡ Auto-buy: ${user.autoBuy ? "ON ✅" : "OFF ❌"}`, "toggle_autobuy")],
    [Markup.button.callback(`🎯 Slippage: ${user.slippage}%`, "set_slippage"), Markup.button.callback(`💰 Default: ${user.defaultBuyAmount} MON`, "set_default")],
    [Markup.button.callback("« Back", "main_menu")]
  ]);
}

function createPositionKeyboard(positions) {
  const buttons = [];
  for (let i = 0; i < positions.length; i += 2) {
    const row = [];
    if (positions[i]) {
      const pos = positions[i];
      const symbol = pos.symbol || pos.ca.substring(0, 8) + "...";
      row.push(Markup.button.callback(`${symbol}`, `position_${i}`));
    }
    if (positions[i + 1]) {
      const pos = positions[i + 1];
      const symbol = pos.symbol || pos.ca.substring(0, 8) + "...";
      row.push(Markup.button.callback(`${symbol}`, `position_${i + 1}`));
    }
    buttons.push(row);
  }
  buttons.push([Markup.button.callback("🔄 Refresh", "refresh_positions"), Markup.button.callback("« Back", "main_menu")]);
  return Markup.inlineKeyboard(buttons);
}

function createSellPercentageKeyboard(tokenId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("25%", `sell_percent_${tokenId}_25`), Markup.button.callback("50%", `sell_percent_${tokenId}_50`)],
    [Markup.button.callback("75%", `sell_percent_${tokenId}_75`), Markup.button.callback("100%", `sell_percent_${tokenId}_100`)],
    [Markup.button.callback("Custom Amount", `sell_custom_${tokenId}`), Markup.button.callback("« Back", "positions")]
  ]);
}

function createWallet(userId) {
  const wallet = ethers.Wallet.createRandom();
  const data = {
    address: wallet.address,
    pk: wallet.privateKey,
    autoBuy: false,
    autoSell: { enabled: false, triggers: [] },
    slippage: 10,
    positions: [],
    defaultBuyAmount: "0.1",
    dcaCampaigns: []
  };
  dbSaveWallet(String(userId), data);
  return data;
}

function getWallet(userId) {
  return dbGetWallet(String(userId));
}

function requireAuth(ctx, next) {
  if (!authenticatedUsers.has(ctx.from.id)) {
    ctx.reply("🔒 Access denied. Please authenticate first with /auth <password>");
    return;
  }
  return next();
}

async function getTokenMetadata(tokenAddress) {
  try {
    const response = await fetch(`${API_BASE}/token/metadata/${tokenAddress}`);
    if (response.ok) {
      const data = await response.json();
      return data.token_metadata;
    }
    return null;
  } catch (error) {
    console.error("Error fetching token metadata:", error);
    return null;
  }
}

async function getMarketData(tokenAddress) {
  try {
    const response = await fetch(`${API_BASE}/trade/market/${tokenAddress}`);
    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (error) {
    console.error("Error fetching market data:", error);
    return null;
  }
}

async function calculateMarketCap(tokenAddress, price) {
  try {
    const token = new ethers.Contract(tokenAddress, tokenAbi, provider);
    const totalSupply = await token.totalSupply();
    const decimals = await token.decimals ? await token.decimals() : 18;
    
    const supplyInTokens = parseFloat(ethers.formatUnits(totalSupply, decimals));
    const marketCap = supplyInTokens * parseFloat(price);
    
    return marketCap;
  } catch (error) {
    console.error("Error calculating market cap:", error);
    return 0;
  }
}

async function getTopHolders(tokenAddress) {
  try {
    // Try to fetch real holder data from API first
    const response = await fetch(`${API_BASE}/token/holders/${tokenAddress}`);
    if (response.ok) {
      const data = await response.json();
      if (data.holders && data.holders.length > 0) {
        return data.holders.slice(0, 10);
      }
    }
    
    // Fallback: return empty array or minimal data
    console.log("No holder data available from API");
    return [];
    
  } catch (error) {
    console.error("Error fetching top holders:", error);
    return [];
  }
}

async function getTokenBalance(tokenAddress, userAddress) {
  try {
    const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
    const balance = await token.balanceOf(userAddress);
    const decimals = await token.decimals();
    return { balance, decimals };
  } catch (error) {
    console.error("Error fetching token balance:", error);
    return { balance: "0", decimals: 18 };
  }
}

async function getMonBalance(address) {
  try {
    const balance = await provider.getBalance(address);
    return ethers.formatEther(balance);
  } catch (error) {
    console.error("Error fetching MON balance:", error);
    return "0";
  }
}

async function checkAutoSellTriggers() {
  for (const userId of authenticatedUsers) {
    const user = getWallet(userId);
    if (!user?.autoSell?.enabled || !user.positions?.length) continue;
    
    for (const position of user.positions) {
      try {
        const marketData = await getMarketData(position.ca);
        if (!marketData) continue;
        
        const currentPrice = parseFloat(marketData.price);
        const marketCap = await calculateMarketCap(position.ca, currentPrice);
        const holdTime = Date.now() - (position.buyTime || 0);
        
        for (const trigger of user.autoSell.triggers) {
          let shouldSell = false;
          
          if (trigger.type === 'marketcap' && marketCap >= trigger.value) {
            shouldSell = true;
          } else if (trigger.type === 'profit' && position.buyPrice) {
            const pnl = ((currentPrice - parseFloat(position.buyPrice)) / parseFloat(position.buyPrice)) * 100;
            if (pnl >= trigger.value) shouldSell = true;
          } else if (trigger.type === 'loss' && position.buyPrice) {
            const pnl = ((currentPrice - parseFloat(position.buyPrice)) / parseFloat(position.buyPrice)) * 100;
            if (pnl <= -trigger.value) shouldSell = true;
          } else if (trigger.type === 'time' && holdTime >= trigger.value) {
            shouldSell = true;
          }
          
          if (shouldSell) {
            await executeAutoSell(userId, position, trigger, marketData);
          }
        }
      } catch (error) {
        console.error(`Auto-sell check error for user ${userId}:`, error);
      }
    }
  }
}

async function executeAutoSell(userId, position, trigger, marketData) {
  try {
    const user = getWallet(userId);
    const wallet = new ethers.Wallet(user.pk, provider);
    
    const { balance } = await getTokenBalance(position.ca, user.address);
    const sellAmount = (BigInt(balance) * BigInt(trigger.percentage || 100)) / 100n;
    
    if (sellAmount === 0n) return;
    
    const token = new ethers.Contract(position.ca, erc20Abi, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    
    let tx;
    if (marketData.market_type === "DEX") {
      const dexRouter = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
      await token.approve(CONTRACTS.DEX_ROUTER, sellAmount);
      
      const quoteData = await dexRouter.getAmountOut(position.ca, sellAmount, false);
      const minOut = (quoteData * (100n - BigInt(user.slippage))) / 100n;
      
      tx = await dexRouter.sell({
        amountIn: sellAmount,
        amountOutMin: minOut,
        token: position.ca,
        to: user.address,
        deadline
      });
    } else if (marketData.market_type === "CURVE") {
      const bondingRouter = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, wallet);
      await token.approve(CONTRACTS.BONDING_CURVE_ROUTER, sellAmount);
      
      tx = await bondingRouter.sell({
        amountIn: sellAmount,
        amountOutMin: 0,
        token: position.ca,
        to: user.address,
        deadline
      });
    }
    
    if (tx) {
      const metadata = await getTokenMetadata(position.ca);
      bot.telegram.sendMessage(userId, 
        `🤖 Auto-sell Executed!\n\n🎯 Trigger: ${trigger.type}\n💰 Token: ${metadata?.symbol || position.ca.substring(0, 12)}\n📊 Amount: ${trigger.percentage || 100}%\n🔗 TX: ${createTxLink(tx.hash)}`,
        { parse_mode: 'Markdown' }
      );
      
      user.autoSell.triggers = user.autoSell.triggers.filter(t => t !== trigger);
      dbSaveWallet(String(userId), user);
    }
  } catch (error) {
    console.error("Auto-sell execution error:", error);
  }
}

async function executeDCA() {
  for (const userId of authenticatedUsers) {
    const user = getWallet(userId);
    if (!user?.dcaCampaigns?.length) continue;
    
    for (let i = 0; i < user.dcaCampaigns.length; i++) {
      const campaign = user.dcaCampaigns[i];
      if (!campaign.active || campaign.nextExecution > Date.now()) continue;
      
      try {
        const marketData = await getMarketData(campaign.tokenAddress);
        const metadata = await getTokenMetadata(campaign.tokenAddress);
        
        if (!marketData) continue;
        
        const wallet = new ethers.Wallet(user.pk, provider);
        const amountIn = ethers.parseEther(campaign.amount);
        
        let tx;
        if (marketData.market_type === "DEX") {
          const dexRouter = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
          const estimatedAmountOut = await dexRouter.getAmountOut(campaign.tokenAddress, amountIn, true);
          const minOut = (estimatedAmountOut * (100n - BigInt(user.slippage))) / 100n;
          
          tx = await dexRouter.buy({
            amountOutMin: minOut,
            token: campaign.tokenAddress,
            to: user.address,
            deadline: Math.floor(Date.now() / 1000) + 1800
          }, { value: amountIn });
        } else if (marketData.market_type === "CURVE") {
          const bondingRouter = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, wallet);
          const amountOut = await bondingRouter.getAmountOut(campaign.tokenAddress, amountIn, true);
          const minOut = (amountOut * (100n - BigInt(user.slippage))) / 100n;
          
          tx = await bondingRouter.buy({
            amountOutMin: minOut,
            token: campaign.tokenAddress,
            to: user.address,
            deadline: Math.floor(Date.now() / 1000) + 1800
          }, { value: amountIn });
        }
        
        if (tx) {
          user.dcaCampaigns[i].executedCount++;
          user.dcaCampaigns[i].nextExecution = Date.now() + (campaign.intervalMinutes * 60 * 1000);
          
          if (user.dcaCampaigns[i].executedCount >= campaign.maxExecutions) {
            user.dcaCampaigns[i].active = false;
          }
          
          bot.telegram.sendMessage(userId,
            `📈 DCA Buy Executed!\n\n💰 Token: ${metadata?.symbol || campaign.tokenAddress.substring(0, 12)}\n💵 Amount: ${campaign.amount} MON\n🔄 Execution: ${user.dcaCampaigns[i].executedCount}/${campaign.maxExecutions}\n🔗 TX: ${createTxLink(tx.hash)}`,
            { parse_mode: 'Markdown' }
          );
          
          const existingPosition = user.positions.find(p => p.ca === campaign.tokenAddress);
          if (!existingPosition) {
            user.positions.push({
              ca: campaign.tokenAddress,
              amount: "?",
              buyPrice: marketData.price,
              buyTime: Date.now()
            });
          }
          dbSaveWallet(String(userId), user);
        }
      } catch (error) {
        console.error(`DCA execution error for user ${userId}, campaign ${i}:`, error);
      }
    }
  }
}

async function executeSell(ctx, positionIndex, percentage) {
  const user = getWallet(ctx.from.id);
  if (!user || !user.positions[positionIndex]) {
    const errorMsg = "❌ Position not found";
    if (ctx.editMessageText) {
      return ctx.editMessageText(errorMsg, Markup.inlineKeyboard([[Markup.button.callback("« Back", "positions")]]));
    } else {
      return ctx.reply(errorMsg, Markup.inlineKeyboard([[Markup.button.callback("« Back", "positions")]]));
    }
  }

  const pos = user.positions[positionIndex];
  const wallet = new ethers.Wallet(user.pk, provider);

  try {
    let statusMsg;
    if (ctx.editMessageText) {
      statusMsg = await ctx.editMessageText(`⚡ Selling ${percentage}%... Preparing transaction`);
    } else {
      statusMsg = await ctx.reply(`⚡ Selling ${percentage}%... Preparing transaction`);
    }

    const [balanceData, metadata, marketData] = await Promise.all([
      getTokenBalance(pos.ca, user.address),
      getTokenMetadata(pos.ca),
      getMarketData(pos.ca)
    ]);

    const { balance, decimals } = balanceData;
    const sellAmount = (BigInt(balance) * BigInt(percentage)) / BigInt(100);
    
    if (sellAmount === 0n) {
      user.positions.splice(positionIndex, 1);
      dbSaveWallet(String(ctx.from.id), user);
      
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        "❌ No tokens to sell - position removed",
        Markup.inlineKeyboard([[Markup.button.callback("📊 Positions", "positions")]])
      );
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `⚡ Selling ${percentage}% of ${metadata?.symbol || "tokens"}... Submitting`
    );

    const token = new ethers.Contract(pos.ca, erc20Abi, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    let tx;
    
    if (marketData.market_type === "DEX") {
      const dexRouterWithWallet = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
      
      const approveTx = await token.approve(CONTRACTS.DEX_ROUTER, sellAmount);
      await approveTx.wait();
      
      const quoteData = await dexRouterWithWallet.getAmountOut(pos.ca, sellAmount, false);
      const minOut = (quoteData * (100n - BigInt(user.slippage))) / 100n;

      const sellParams = {
        amountIn: sellAmount,
        amountOutMin: minOut,
        token: pos.ca,
        to: user.address,
        deadline: deadline
      };

      tx = await dexRouterWithWallet.sell(sellParams);
      
    } else if (marketData.market_type === "CURVE") {
      const approveTx = await token.approve(CONTRACTS.BONDING_CURVE_ROUTER, sellAmount);
      await approveTx.wait();
      
      const sellParams = {
        amountIn: sellAmount,
        amountOutMin: 0,
        token: pos.ca,
        to: user.address,
        deadline: deadline
      };

      const bondingCurveWrite = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, wallet);
      tx = await bondingCurveWrite.sell(sellParams);
      
    } else {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `❌ Unsupported market type: ${marketData.market_type}`,
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "positions")]])
      );
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `⏳ Sell submitted! Hash: ${tx.hash.substring(0, 20)}...`
    );

    tx.wait().then(async () => {
      if (percentage === 100) {
        user.positions.splice(positionIndex, 1);
      } else {
        const { balance: newBalance } = await getTokenBalance(pos.ca, user.address);
        user.positions[positionIndex].amount = ethers.formatUnits(newBalance, decimals);
      }
      
      dbSaveWallet(String(ctx.from.id), user);
      
      ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `✅ Sell Complete!
🎯 Sold ${percentage}% of ${metadata?.symbol || "tokens"}
💰 ${formatTokenAmount(sellAmount, decimals)} tokens
🔗 TX: ${createTxLink(tx.hash)}`,
        { 
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback("📊 Positions", "positions"), Markup.button.callback("« Menu", "main_menu")]])
        }
      );
    }).catch(err => {
      console.error("Transaction confirmation error:", err);
      ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `⚠️ Sell submitted but confirmation failed. Check hash: ${createTxLink(tx.hash)}`,
        { 
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback("📊 Positions", "positions")]])
        }
      );
    });

  } catch (err) {
    console.error("Sell error:", err);
    
    let errorMsg = "❌ Sell failed: ";
    if (err.message.includes("UNSUPPORTED_OPERATION")) {
      errorMsg += "Contract connection error. Please try again.";
    } else if (err.message.includes("insufficient funds")) {
      errorMsg += "Insufficient balance for gas fees.";
    } else if (err.message.includes("execution reverted")) {
      errorMsg += "Transaction reverted. Check token balance and try again.";
    } else {
      errorMsg += err.message.substring(0, 100);
    }
    
    if (ctx.editMessageText) {
      ctx.editMessageText(errorMsg, Markup.inlineKeyboard([[Markup.button.callback("« Back", "positions")]]));
    } else {
      ctx.reply(errorMsg, Markup.inlineKeyboard([[Markup.button.callback("« Back", "positions")]]));
    }
  }
}

async function executeAutoBuy(ctx, tokenAddress, metadata, marketData, user) {
  const wallet = new ethers.Wallet(user.pk, provider);
  
  try {
    const amountIn = ethers.parseEther(user.defaultBuyAmount);
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    const statusMsg = await ctx.reply(`⚡ Auto-buy executing...
🏷️ Token: ${metadata.symbol}
💰 Amount: ${user.defaultBuyAmount} MON
🎯 Slippage: ${user.slippage}%`, 
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel_buy")]]));

    let tx;
    
    if (marketData.market_type === "DEX") {
      const dexRouterWithWallet = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
      
      const estimatedAmountOut = await dexRouterWithWallet.getAmountOut(tokenAddress, amountIn, true);
      const minOut = (estimatedAmountOut * (100n - BigInt(user.slippage))) / 100n;
      
      const buyParams = {
        amountOutMin: minOut,
        token: tokenAddress,
        to: user.address,
        deadline: deadline
      };

      tx = await dexRouterWithWallet.buy(buyParams, { value: amountIn });
      
    } else if (marketData.market_type === "CURVE") {
      const bondingCurveRead = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, provider);
      const amountOut = await bondingCurveRead.getAmountOut(tokenAddress, amountIn, true);
      const minOut = (amountOut * (100n - BigInt(user.slippage))) / 100n;

      const buyParams = {
        amountOutMin: minOut,
        token: tokenAddress,
        to: user.address,
        deadline: deadline
      };

      const bondingCurveWrite = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, wallet);
      tx = await bondingCurveWrite.buy(buyParams, { value: amountIn });
    } else {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        "❌ Unsupported market type",
        createMainKeyboard()
      );
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `⏳ Transaction submitted...\n🔗 Hash: ${tx.hash.substring(0, 20)}...`
    );

    await tx.wait();

    const existingPosition = user.positions.find(p => p.ca === tokenAddress);
    if (!existingPosition) {
      user.positions.push({ 
        ca: tokenAddress, 
        amount: "?", 
        buyPrice: marketData.price,
        buyTime: Date.now()
      });
    }
    dbSaveWallet(String(ctx.from.id), user);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ Auto-buy Successful!
🏷️ Token: ${metadata.symbol}
💰 Bought: ${user.defaultBuyAmount} MON worth
💵 Price: ${formatPrice(marketData.price)} MON
📈 Market: ${marketData.market_type}
🔗 Hash: ${createTxLink(tx.hash)}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📊 View Position", "positions")],
          [Markup.button.callback("« Main Menu", "main_menu")]
        ])
      }
    );

  } catch (err) {
    console.error(`Auto-buy failed for user ${ctx.from.id}:`, err);
    
    let errorMsg = "❌ Auto-buy failed: ";
    if (err.message.includes("UNSUPPORTED_OPERATION")) {
      errorMsg += "Contract connection error. Please try again.";
    } else if (err.message.includes("insufficient funds")) {
      errorMsg += "Insufficient MON balance for purchase + gas fees.";
    } else {
      errorMsg += err.message.substring(0, 100);
    }
    
    ctx.reply(errorMsg, 
      Markup.inlineKeyboard([[Markup.button.callback("« Main Menu", "main_menu")]]));
  }
}

async function analyzeToken(ctx, tokenAddress) {
  try {
    const statusMsg = await ctx.reply("🔍 Analyzing token... Please wait");
    
    const [metadata, marketData, topHolders] = await Promise.all([
      getTokenMetadata(tokenAddress),
      getMarketData(tokenAddress),
      getTopHolders(tokenAddress)
    ]);
    
    if (!metadata) {
      return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, "❌ Token not found");
    }
    
    const price = marketData?.price ? formatPrice(marketData.price) : "N/A";
    const marketCap = marketData?.price ? await calculateMarketCap(tokenAddress, marketData.price) : 0;
    
    let holdersText = "👥 Top Holders:\n";
    let totalTopHoldersPercentage = 0;
    
    if (topHolders.length > 0) {
      topHolders.forEach((holder, index) => {
        totalTopHoldersPercentage += parseFloat(holder.percentage);
        holdersText += `${index + 1}. ${holder.address.substring(0, 8)}... - ${holder.percentage}%\n`;
      });
      holdersText += `\n📊 Top ${topHolders.length} holders own: ${totalTopHoldersPercentage.toFixed(2)}%`;
    } else {
      holdersText += "No holder data available\n";
    }
    
    const analysisText = `🔍 Token Analysis

🏷️ ${metadata.name} (${metadata.symbol})
📍 ${tokenAddress.substring(0, 12)}...${tokenAddress.substring(tokenAddress.length - 8)}
💰 Price: ${price} MON
📊 Market Cap: ${formatMcap(marketCap)}
📈 Market Type: ${marketData?.market_type || "Unknown"}

${holdersText}`;
    
    ctx.telegram.editMessageText(
      ctx.chat.id, 
      statusMsg.message_id, 
      undefined, 
      analysisText,
      Markup.inlineKeyboard([
        [Markup.button.callback(`⚡ Buy ${getWallet(ctx.from.id).defaultBuyAmount} MON`, `quick_buy_${tokenAddress}`)],
        [Markup.button.callback("🎯 Set Auto-sell", `set_autosell_${tokenAddress}`)],
        [Markup.button.callback("« Back", "main_menu")]
      ])
    );
  } catch (error) {
    console.error("Token analysis error:", error);
    ctx.reply("❌ Analysis failed. Please try again.");
  }
}

// Cron jobs for automated features
cron.schedule('*/1 * * * *', checkAutoSellTriggers);
cron.schedule('*/1 * * * *', executeDCA);

// Bot command handlers
bot.command("auth", (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("Usage: /auth <password>");
  }
  const password = args.slice(1).join(" ");
  
  if (password === "mbdagoat") {
    authenticatedUsers.add(ctx.from.id);
    ctx.reply("✅ Welcome to Enhanced NAD Bot!", createMainKeyboard());
  } else {
    ctx.reply("❌ Invalid password. Access denied.");
  }
});

bot.start((ctx) => {
  ctx.reply(`🚀 Enhanced NAD Trading Bot!

🔐 This bot is password protected.
Use /auth <password> to authenticate.

✨ Features:
• 🤖 Auto-sell at market cap targets
• 📈 DCA (Dollar Cost Averaging)
• 👥 Token holder analysis
• 🔗 Clickable transaction links
• ⚡ Advanced automation
• ⏱️ Minute-level DCA intervals`, 
    Markup.inlineKeyboard([[Markup.button.callback("🔐 Authenticate", "need_auth")]]));
});

bot.action("need_auth", (ctx) => {
  ctx.editMessageText("Please use /auth <password> to authenticate");
});

bot.action("main_menu", requireAuth, (ctx) => {
  ctx.editMessageText("🚀 Enhanced NAD Trading Bot", createMainKeyboard());
});

bot.action("auto_features", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");
  
  ctx.editMessageText("🤖 Auto Trading Features", createAutoFeaturesKeyboard(user));
});

bot.action("autosell_menu", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");
  
  ctx.editMessageText("🎯 Auto-sell Settings", createAutosellKeyboard(user));
});

bot.action("toggle_autosell", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");
  
  if (!user.autoSell) user.autoSell = { enabled: false, triggers: [] };
  user.autoSell.enabled = !user.autoSell.enabled;
  
  dbSaveWallet(String(ctx.from.id), user);
  ctx.editMessageText("🎯 Auto-sell Settings", createAutosellKeyboard(user));
  ctx.answerCbQuery(`Auto-sell ${user.autoSell.enabled ? "enabled" : "disabled"}!`);
});

bot.action("autosell_mcap", requireAuth, (ctx) => {
  ctx.editMessageText("🎯 Market Cap Target\n\nEnter market cap in millions (e.g., 5 for $5M):");
  pendingActions.set(ctx.from.id, { type: 'autosell_mcap_value' });
});

bot.action("autosell_pnl", requireAuth, (ctx) => {
  ctx.editMessageText("📊 Profit/Loss Target\n\nEnter profit percentage to auto-sell (e.g., 50 for +50%):");
  pendingActions.set(ctx.from.id, { type: 'autosell_profit_value' });
});

bot.action("autosell_time", requireAuth, (ctx) => {
  ctx.editMessageText("⏰ Time-based Auto-sell\n\nEnter minutes to hold before auto-sell (e.g., 60 for 1 hour, 1440 for 1 day):");
  pendingActions.set(ctx.from.id, { type: 'autosell_time_value' });
});

bot.action("dca_menu", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");
  
  const campaigns = user.dcaCampaigns || [];
  ctx.editMessageText("📈 DCA Campaigns", createDCAKeyboard(campaigns));
});

bot.action("dca_new", requireAuth, (ctx) => {
  ctx.editMessageText("📈 New DCA Campaign\n\nEnter token address:");
  pendingActions.set(ctx.from.id, { type: 'dca_token' });
});

bot.action(/^dca_view_(\d+)$/, requireAuth, async (ctx) => {
  const campaignIndex = parseInt(ctx.match[1]);
  const user = getWallet(ctx.from.id);
  
  if (!user?.dcaCampaigns?.[campaignIndex]) {
    return ctx.answerCbQuery("❌ Campaign not found");
  }
  
  const campaign = user.dcaCampaigns[campaignIndex];
  const metadata = await getTokenMetadata(campaign.tokenAddress);
  const nextExecutionTime = new Date(campaign.nextExecution).toLocaleString();
  const status = campaign.active ? "🟢 Active" : "🔴 Inactive";
  const progress = `${campaign.executedCount}/${campaign.maxExecutions}`;
  const intervalText = formatInterval(campaign.intervalMinutes);
  
  const message = `📈 DCA Campaign Details

💰 Token: ${metadata?.symbol || campaign.tokenSymbol}
📍 Address: ${campaign.tokenAddress.substring(0, 12)}...
💵 Amount per buy: ${campaign.amount} MON
⏰ Interval: ${intervalText}
🔄 Progress: ${progress} executions
📊 Status: ${status}
⏳ Next execution: ${campaign.active ? nextExecutionTime : 'Completed'}

Created: ${new Date(campaign.created).toLocaleDateString()}`;

  ctx.editMessageText(message, Markup.inlineKeyboard([
    [Markup.button.callback(campaign.active ? "⏸️ Pause" : "▶️ Resume", `dca_toggle_${campaignIndex}`)],
    [Markup.button.callback("🗑️ Delete", `dca_delete_${campaignIndex}`)],
    [Markup.button.callback("« Back", "dca_menu")]
  ]));
});

bot.action(/^dca_toggle_(\d+)$/, requireAuth, (ctx) => {
  const campaignIndex = parseInt(ctx.match[1]);
  const user = getWallet(ctx.from.id);
  
  if (!user?.dcaCampaigns?.[campaignIndex]) {
    return ctx.answerCbQuery("❌ Campaign not found");
  }
  
  user.dcaCampaigns[campaignIndex].active = !user.dcaCampaigns[campaignIndex].active;
  
  if (user.dcaCampaigns[campaignIndex].active && user.dcaCampaigns[campaignIndex].executedCount < user.dcaCampaigns[campaignIndex].maxExecutions) {
    user.dcaCampaigns[campaignIndex].nextExecution = Date.now() + (user.dcaCampaigns[campaignIndex].intervalMinutes * 60 * 1000);
  }
  
  dbSaveWallet(String(ctx.from.id), user);
  
  const status = user.dcaCampaigns[campaignIndex].active ? "resumed" : "paused";
  ctx.answerCbQuery(`✅ Campaign ${status}!`);
  
  setTimeout(() => {
    ctx.emit(`action:dca_view_${campaignIndex}`);
  }, 100);
});

bot.action(/^dca_delete_(\d+)$/, requireAuth, (ctx) => {
  const campaignIndex = parseInt(ctx.match[1]);
  const user = getWallet(ctx.from.id);
  
  if (!user?.dcaCampaigns?.[campaignIndex]) {
    return ctx.answerCbQuery("❌ Campaign not found");
  }
  
  user.dcaCampaigns.splice(campaignIndex, 1);
  dbSaveWallet(String(ctx.from.id), user);
  
  ctx.answerCbQuery("✅ Campaign deleted!");
  ctx.editMessageText("📈 DCA Campaigns", createDCAKeyboard(user.dcaCampaigns));
});

bot.action("token_info", requireAuth, (ctx) => {
  ctx.editMessageText("🔍 Token Analysis\n\nEnter token address to analyze:");
  pendingActions.set(ctx.from.id, { type: 'token_info' });
});

bot.on("text", requireAuth, async (ctx) => {
  const text = ctx.message.text.trim();
  
  if (pendingActions.has(ctx.from.id)) {
    const action = pendingActions.get(ctx.from.id);
    
    switch (action.type) {
      case 'autosell_mcap_value':
        const mcap = parseFloat(text);
        if (isNaN(mcap) || mcap <= 0) {
          return ctx.reply("❌ Invalid market cap. Please enter a positive number.");
        }
        
        const user = getWallet(ctx.from.id);
        if (!user.autoSell) user.autoSell = { enabled: true, triggers: [] };
        
        user.autoSell.triggers.push({
          type: 'marketcap',
          value: mcap * 1000000,
          percentage: 100
        });
        
        dbSaveWallet(String(ctx.from.id), user);
        pendingActions.delete(ctx.from.id);
        
        ctx.reply(`✅ Auto-sell trigger set for ${formatMcap(mcap * 1000000)} market cap!`, createAutosellKeyboard(user));
        break;
        
      case 'autosell_profit_value':
        const profit = parseFloat(text);
        if (isNaN(profit) || profit <= 0) {
          return ctx.reply("❌ Invalid profit percentage. Please enter a positive number.");
        }
        
        const userProfit = getWallet(ctx.from.id);
        if (!userProfit.autoSell) userProfit.autoSell = { enabled: true, triggers: [] };
        
        userProfit.autoSell.triggers.push({
          type: 'profit',
          value: profit,
          percentage: 100
        });
        
        dbSaveWallet(String(ctx.from.id), userProfit);
        pendingActions.delete(ctx.from.id);
        
        ctx.reply(`✅ Auto-sell trigger set for +${profit}% profit!`, createAutosellKeyboard(userProfit));
        break;
        
      case 'autosell_time_value':
        const minutes = parseInt(text);
        if (isNaN(minutes) || minutes <= 0) {
          return ctx.reply("❌ Invalid time. Please enter a positive number of minutes.");
        }
        
        const userTime = getWallet(ctx.from.id);
        if (!userTime.autoSell) userTime.autoSell = { enabled: true, triggers: [] };
        
        userTime.autoSell.triggers.push({
          type: 'time',
          value: minutes * 60 * 1000,
          percentage: 100
        });
        
        dbSaveWallet(String(ctx.from.id), userTime);
        pendingActions.delete(ctx.from.id);
        
        ctx.reply(`✅ Auto-sell trigger set for ${formatInterval(minutes)} hold time!`, createAutosellKeyboard(userTime));
        break;
        
      case 'slippage':
        const slippage = parseFloat(text);
        if (isNaN(slippage) || slippage < 1 || slippage > 50) {
          return ctx.reply("❌ Invalid slippage. Enter a number between 1 and 50.");
        }
        
        const userSlippage = getWallet(ctx.from.id);
        userSlippage.slippage = slippage;
        dbSaveWallet(String(ctx.from.id), userSlippage);
        pendingActions.delete(ctx.from.id);
        
        return ctx.reply(`✅ Slippage set to ${slippage}%`, createSettingsKeyboard(userSlippage));
        
      case 'default_amount':
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
          return ctx.reply("❌ Invalid amount. Enter a positive number.");
        }
        
        const userAmount = getWallet(ctx.from.id);
        userAmount.defaultBuyAmount = text;
        dbSaveWallet(String(ctx.from.id), userAmount);
        pendingActions.delete(ctx.from.id);
        
        return ctx.reply(`✅ Default buy amount set to ${text} MON`, createSettingsKeyboard(userAmount));
        
      case 'dca_token':
        if (!ethers.isAddress(text)) {
          return ctx.reply("❌ Invalid token address.");
        }
        
        pendingActions.set(ctx.from.id, { type: 'dca_amount', tokenAddress: text });
        ctx.reply("💰 Enter amount in MON per buy (e.g., 0.1):");
        break;
        
      case 'dca_amount':
        const dcaAmount = parseFloat(text);
        if (isNaN(dcaAmount) || dcaAmount <= 0) {
          return ctx.reply("❌ Invalid amount. Please enter a positive number.");
        }
        
        const actionData = pendingActions.get(ctx.from.id);
        pendingActions.set(ctx.from.id, { ...actionData, type: 'dca_interval', amount: text });
        ctx.reply("⏰ Enter interval in minutes (e.g., 5 for 5 minutes, 60 for 1 hour, 1440 for daily):");
        break;
        
      case 'dca_interval':
        const intervalMinutes = parseInt(text);
        if (isNaN(intervalMinutes) || intervalMinutes <= 0) {
          return ctx.reply("❌ Invalid interval. Please enter a positive number of minutes.");
        }
        
        const dcaData = pendingActions.get(ctx.from.id);
        pendingActions.set(ctx.from.id, { ...dcaData, type: 'dca_executions', intervalMinutes: intervalMinutes });
        ctx.reply("🔄 Enter total number of buys (e.g., 10):");
        break;
        
      case 'dca_executions':
        const executions = parseInt(text);
        if (isNaN(executions) || executions <= 0) {
          return ctx.reply("❌ Invalid number. Please enter a positive number.");
        }
        
        const finalDcaData = pendingActions.get(ctx.from.id);
        const user2 = getWallet(ctx.from.id);
        
        if (!user2.dcaCampaigns) user2.dcaCampaigns = [];
        
        const metadata = await getTokenMetadata(finalDcaData.tokenAddress);
        
        const campaign = {
          id: Date.now(),
          tokenAddress: finalDcaData.tokenAddress,
          tokenSymbol: metadata?.symbol || finalDcaData.tokenAddress.substring(0, 8),
          amount: finalDcaData.amount,
          intervalMinutes: finalDcaData.intervalMinutes,
          maxExecutions: executions,
          executedCount: 0,
          active: true,
          created: Date.now(),
          nextExecution: Date.now() + (finalDcaData.intervalMinutes * 60 * 1000)
        };
        
        user2.dcaCampaigns.push(campaign);
        
        dbSaveWallet(String(ctx.from.id), user2);
        pendingActions.delete(ctx.from.id);
        
        const intervalText = formatInterval(finalDcaData.intervalMinutes);
        
        ctx.reply(`✅ DCA Campaign Created!\n\n💰 Amount: ${campaign.amount} MON\n⏰ Interval: ${intervalText}\n🔄 Total Buys: ${campaign.maxExecutions}\n🚀 Starting in ${intervalText}!`, createDCAKeyboard(user2.dcaCampaigns));
        break;
        
      case 'token_info':
        if (!ethers.isAddress(text)) {
          return ctx.reply("❌ Invalid token address.");
        }
        
        await analyzeToken(ctx, text);
        pendingActions.delete(ctx.from.id);
        break;
    }
    return;
  }
  
  // Handle token address detection for auto-buy
  if (text.startsWith("0x") && text.length === 42 && ethers.isAddress(text)) {
    const user = getWallet(ctx.from.id);
    if (!user) return;

    const metadata = await getTokenMetadata(text);
    const marketData = await getMarketData(text);

    if (!metadata) {
      return ctx.reply(`❌ Token not found: ${text.substring(0, 12)}...`, createMainKeyboard());
    }

    const price = marketData?.price ? formatPrice(marketData.price) : "N/A";
    const marketCap = marketData?.price ? await calculateMarketCap(text, marketData.price) : 0;
    
    if (!user.autoBuy) {
      return ctx.reply(`🔍 Token Detected: ${metadata.symbol}

🏷️ Name: ${metadata.name}
📍 Address: ${text.substring(0, 12)}...
📈 Market: ${marketData?.market_type || "Unknown"}
💰 Price: ${price} MON
📊 Market Cap: ${formatMcap(marketCap)}

⚡ Auto-buy is OFF`, 
        Markup.inlineKeyboard([
          [Markup.button.callback(`⚡ Buy ${user.defaultBuyAmount} MON`, `quick_buy_${text}`)],
          [Markup.button.callback("🔍 Analyze Token", `analyze_${text}`)],
          [Markup.button.callback("⚙️ Enable Auto-buy", "toggle_autobuy"), Markup.button.callback("« Back", "main_menu")]
        ]));
    }

    if (!marketData) {
      return ctx.reply(`❌ Token ${metadata.symbol} is not tradeable yet`, createMainKeyboard());
    }

    await executeAutoBuy(ctx, text, metadata, marketData, user);
  }
});

bot.action("wallet", requireAuth, async (ctx) => {
  let user = getWallet(ctx.from.id);
  if (!user) user = createWallet(ctx.from.id);

  const monBalance = await getMonBalance(user.address);
  
  const message = `👤 Your Wallet

🦀 Address: \`${user.address}\`
💰 Balance: ${formatPrice(monBalance)} MON
⚡ Auto-buy: ${user.autoBuy ? "ON ✅" : "OFF ❌"}
🎯 Slippage: ${user.slippage}%
💰 Default: ${user.defaultBuyAmount} MON`;

  ctx.editMessageText(message, { 
    parse_mode: 'Markdown',
    ...createWalletKeyboard()
  });
});

bot.action("settings", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");

  ctx.editMessageText("⚙️ Settings", createSettingsKeyboard(user));
});

bot.action("toggle_autobuy", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");

  user.autoBuy = !user.autoBuy;
  dbSaveWallet(String(ctx.from.id), user);
  
  ctx.editMessageText("⚙️ Settings", createSettingsKeyboard(user));
  ctx.answerCbQuery(`Auto-buy ${user.autoBuy ? "enabled" : "disabled"}!`);
});

bot.action("positions", requireAuth, async (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user || !user.positions.length) {
    return ctx.editMessageText("📂 No positions yet\n\nStart trading to see your positions here!", 
      Markup.inlineKeyboard([[Markup.button.callback("« Back", "main_menu")]]));
  }

  let message = "📊 Your Positions:\n\n";
  const enrichedPositions = [];
  const validPositions = [];
  
  for (let i = 0; i < user.positions.length; i++) {
    const pos = user.positions[i];
    try {
      const { balance, decimals } = await getTokenBalance(pos.ca, user.address);
      const tokenBalance = parseFloat(ethers.formatUnits(balance, decimals));
      
      if (tokenBalance > 0) {
        const metadata = await getTokenMetadata(pos.ca);
        const marketData = await getMarketData(pos.ca);
        
        const symbol = metadata?.symbol || pos.ca.substring(0, 8) + "...";
        const price = marketData?.price ? formatPrice(marketData.price) : "N/A";
        const value = marketData?.price ? formatPrice(tokenBalance * parseFloat(marketData.price)) : "N/A";
        
        let pnlText = "";
        if (pos.buyPrice && marketData?.price) {
          const currentPrice = parseFloat(marketData.price);
          const buyPrice = parseFloat(pos.buyPrice);
          const pnl = ((currentPrice - buyPrice) / buyPrice) * 100;
          const pnlColor = pnl >= 0 ? "🟢" : "🔴";
          pnlText = ` ${pnlColor} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
        }
        
        const positionInfo = {
          ...pos,
          symbol,
          balance: tokenBalance,
          price,
          value,
          index: validPositions.length,
          decimals
        };
        
        validPositions.push(pos);
        enrichedPositions.push(positionInfo);
        
        message += `${enrichedPositions.length}. ${symbol}
💰 ${formatTokenAmount(balance, decimals)} tokens
💵 ${price} MON${pnlText}
📊 Value: ~${value} MON

`;
      }
    } catch (error) {
      console.error(`Error loading position ${pos.ca}:`, error);
    }
  }

  user.positions = validPositions;
  dbSaveWallet(String(ctx.from.id), user);

  if (enrichedPositions.length === 0) {
    message = "🔭 No active positions\n\nAll token balances are zero.";
    return ctx.editMessageText(message, 
      Markup.inlineKeyboard([[Markup.button.callback("« Back", "main_menu")]]));
  }

  ctx.editMessageText(message, createPositionKeyboard(enrichedPositions));
});

bot.action(/^position_(\d+)$/, requireAuth, async (ctx) => {
  const positionIndex = parseInt(ctx.match[1]);
  const user = getWallet(ctx.from.id);
  if (!user || !user.positions[positionIndex]) {
    return ctx.answerCbQuery("❌ Position not found");
  }

  const pos = user.positions[positionIndex];
  const metadata = await getTokenMetadata(pos.ca);
  const marketData = await getMarketData(pos.ca);
  const { balance, decimals } = await getTokenBalance(pos.ca, user.address);
  
  const symbol = metadata?.symbol || "Unknown";
  const tokenBalance = parseFloat(ethers.formatUnits(balance, decimals));
  const price = marketData?.price ? formatPrice(marketData.price) : "N/A";
  
  let pnlText = "";
  if (pos.buyPrice && marketData?.price) {
    const currentPrice = parseFloat(marketData.price);
    const buyPrice = parseFloat(pos.buyPrice);
    const pnl = ((currentPrice - buyPrice) / buyPrice) * 100;
    const pnlColor = pnl >= 0 ? "🟢" : "🔴";
    pnlText = `${pnlColor} P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
  }

  const message = `📊 ${symbol} Position

🦀 Address: ${pos.ca.substring(0, 12)}...
💰 Balance: ${formatTokenAmount(balance, decimals)}
💵 Price: ${price} MON
${pnlText}

Choose sell amount:`;

  ctx.editMessageText(message, createSellPercentageKeyboard(positionIndex));
});

bot.action(/^sell_percent_(\d+)_(\d+)$/, requireAuth, async (ctx) => {
  const [, positionIndex, percentage] = ctx.match;
  
  if (ctx.callbackQuery) {
    try {
      await ctx.answerCbQuery();
    } catch (err) {
      console.error("Failed to answer callback query:", err.message);
    }
  }
  
  await executeSell(ctx, parseInt(positionIndex), parseInt(percentage));
});

bot.action(/^sell_custom_(\d+)$/, requireAuth, (ctx) => {
  const positionIndex = ctx.match[1];
  pendingActions.set(ctx.from.id, { type: 'custom_sell', positionIndex: parseInt(positionIndex) });
  ctx.editMessageText("💰 Enter the amount of tokens to sell:\n\nReply with just the number (e.g., 1000000)");
});

bot.action(/^quick_buy_(.+)$/, requireAuth, async (ctx) => {
  const tokenAddress = ctx.match[1];
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");

  const metadata = await getTokenMetadata(tokenAddress);
  const marketData = await getMarketData(tokenAddress);
  
  if (!marketData) {
    return ctx.answerCbQuery("❌ Token not tradeable");
  }

  await executeAutoBuy(ctx, tokenAddress, metadata, marketData, user);
});

bot.action(/^analyze_(.+)$/, requireAuth, async (ctx) => {
  const tokenAddress = ctx.match[1];
  await analyzeToken(ctx, tokenAddress);
});

bot.action(/^set_autosell_(.+)$/, requireAuth, (ctx) => {
  const tokenAddress = ctx.match[1];
  pendingActions.set(ctx.from.id, { type: 'set_autosell', tokenAddress });
  ctx.editMessageText("🎯 Set Auto-sell for this token\n\nChoose trigger type:", 
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Market Cap", "autosell_mcap")],
      [Markup.button.callback("💰 Profit %", "autosell_pnl")],
      [Markup.button.callback("⏰ Time Hold", "autosell_time")],
      [Markup.button.callback("« Back", "main_menu")]
    ])
  );
});

bot.action("balance", requireAuth, async (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");

  const monBalance = await getMonBalance(user.address);
  let message = `💰 Balance Overview:

🪙 MON: ${formatPrice(monBalance)} MON`;

  if (user.positions.length > 0) {
    message += "\n\n🦄 Token Holdings:";
    for (const pos of user.positions) {
      const { balance, decimals } = await getTokenBalance(pos.ca, user.address);
      if (parseFloat(ethers.formatUnits(balance, decimals)) > 0) {
        const metadata = await getTokenMetadata(pos.ca);
        const symbol = metadata?.symbol || pos.ca.substring(0, 8) + "...";
        message += `\n📊 ${symbol}: ${formatTokenAmount(balance, decimals)}`;
      }
    }
  }

  ctx.editMessageText(message, createWalletKeyboard());
});

bot.action("refresh", requireAuth, async (ctx) => {
  ctx.editMessageText("🔄 Refreshing data...");
  setTimeout(() => {
    ctx.editMessageText("🚀 Enhanced NAD Trading Bot", createMainKeyboard());
  }, 1000);
});

bot.action("deposit", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");

  ctx.editMessageText(`💸 Deposit Address:

\`${user.address}\`

Send MON to this address to fund your trading wallet.
⚠️ Only send MON on Monad Testnet!`, { 
    parse_mode: 'Markdown',
    ...createWalletKeyboard()
  });
});

bot.action("export", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.answerCbQuery("❌ No wallet found");

  ctx.editMessageText(`🔑 Private Key: \`${user.pk}\`

⚠️ SECURITY WARNING:
- Save this key securely
- DELETE this message immediately
- Never share with anyone
- This gives full access to your funds`, { 
    parse_mode: 'Markdown',
    ...createWalletKeyboard()
  });
});

bot.action("set_slippage", requireAuth, (ctx) => {
  ctx.editMessageText("🎯 Enter slippage tolerance (1-50):\n\nReply with just the number (e.g., 15)");
  pendingActions.set(ctx.from.id, { type: 'slippage' });
});

bot.action("set_default", requireAuth, (ctx) => {
  ctx.editMessageText("💰 Enter default buy amount in MON:\n\nReply with just the number (e.g., 0.5)");
  pendingActions.set(ctx.from.id, { type: 'default_amount' });
});

bot.action("refresh_wallet", requireAuth, async (ctx) => {
  let user = getWallet(ctx.from.id);
  if (!user) user = createWallet(ctx.from.id);

  const monBalance = await getMonBalance(user.address);
  
  const message = `👤 Your Wallet

🦀 Address: \`${user.address}\`
💰 Balance: ${formatPrice(monBalance)} MON
⚡ Auto-buy: ${user.autoBuy ? "ON ✅" : "OFF ❌"}
🎯 Slippage: ${user.slippage}%
💰 Default: ${user.defaultBuyAmount} MON`;

  ctx.editMessageText(message, { 
    parse_mode: 'Markdown',
    ...createWalletKeyboard()
  });
});

bot.action("refresh_positions", requireAuth, (ctx) => {
  ctx.editMessageText("🔄 Refreshing positions...");
  setTimeout(() => {
    ctx.emit('action:positions');
  }, 500);
});

bot.action("buy_menu", requireAuth, (ctx) => {
  ctx.editMessageText(`📈 Buy Tokens

To buy tokens, simply:
1. Paste any token address
2. Use /buy <address> <amount>

💡 With auto-buy enabled, just paste the address!`, 
    Markup.inlineKeyboard([
      [Markup.button.callback("⚡ Toggle Auto-buy", "toggle_autobuy")],
      [Markup.button.callback("⚙️ Settings", "settings"), Markup.button.callback("« Back", "main_menu")]
    ]));
});

bot.action("sell_menu", requireAuth, (ctx) => {
  ctx.editMessageText(`📉 Sell Tokens

Ways to sell:
• /sell <symbol> <percentage>% - e.g., /sell PEPE 50%
• /sell <address> <amount> - Sell specific amount
• 📊 Use Positions menu for quick sells

Examples:
/sell baddog 25%
/sell 0x123...abc 1000000`, 
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 View Positions", "positions")],
      [Markup.button.callback("« Back", "main_menu")]
    ]));
});

bot.action("cancel_buy", requireAuth, (ctx) => {
  ctx.editMessageText("❌ Buy cancelled", createMainKeyboard());
});

bot.command("sell", requireAuth, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("Usage: /sell <token_address_or_symbol> [amount_or_percentage]\n\nExamples:\n/sell 0x123...abc 50%\n/sell PEPE 1000000\n/sell baddog 25%");
  }

  const [cmd, tokenInput, amountInput] = args;
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found");

  let targetPosition = null;
  let positionIndex = -1;

  if (ethers.isAddress(tokenInput)) {
    positionIndex = user.positions.findIndex(p => p.ca.toLowerCase() === tokenInput.toLowerCase());
    if (positionIndex !== -1) targetPosition = user.positions[positionIndex];
  } else {
    for (let i = 0; i < user.positions.length; i++) {
      const pos = user.positions[i];
      try {
        const metadata = await getTokenMetadata(pos.ca);
        if (metadata?.symbol?.toLowerCase() === tokenInput.toLowerCase()) {
          targetPosition = pos;
          positionIndex = i;
          break;
        }
      } catch (error) {
        continue;
      }
    }
  }

  if (!targetPosition) {
    return ctx.reply("❌ Token not found in your positions");
  }

  if (!amountInput) {
    const metadata = await getTokenMetadata(targetPosition.ca);
    const message = `Select sell amount for ${metadata?.symbol || "token"}:`;
    return ctx.reply(message, createSellPercentageKeyboard(positionIndex));
  }

  if (amountInput.endsWith('%')) {
    const percentage = parseInt(amountInput.replace('%', ''));
    if (percentage > 0 && percentage <= 100) {
      await executeSell({ reply: (text, markup) => ctx.reply(text, markup), chat: ctx.chat, from: ctx.from }, positionIndex, percentage);
    } else {
      ctx.reply("❌ Invalid percentage. Use 1-100%");
    }
  } else {
    ctx.reply("🚧 Specific amount selling will be implemented soon. Use percentages for now.");
  }
});

bot.command("buy", requireAuth, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 3 || !ethers.isAddress(args[1])) {
    return ctx.reply("Usage: /buy <token_address> <mon_amount>\n\nExample: /buy 0x123...abc 0.1", createMainKeyboard());
  }
  const [cmd, ca, monAmount] = args;

  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  const amountNum = parseFloat(monAmount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return ctx.reply("❌ Invalid MON amount. Please enter a positive number.");
  }

  const wallet = new ethers.Wallet(user.pk, provider);

  try {
    const marketData = await getMarketData(ca);
    if (!marketData) {
      return ctx.reply("❌ Token not found or not tradeable");
    }

    const metadata = await getTokenMetadata(ca);
    const amountIn = ethers.parseEther(monAmount);
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    const statusMsg = await ctx.reply(`⏳ Processing buy order...
📊 ${monAmount} MON → ${metadata?.symbol || "tokens"}
🎯 Slippage: ${user.slippage}%
📈 Market: ${marketData.market_type}`, 
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel_buy")]]));

    let tx;
    
    if (marketData.market_type === "DEX") {
      const dexRouterWithWallet = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
      
      const estimatedAmountOut = await dexRouterWithWallet.getAmountOut(ca, amountIn, true);
      const minOut = (estimatedAmountOut * (100n - BigInt(user.slippage))) / 100n;

      const buyParams = {
        amountOutMin: minOut,
        token: ca,
        to: user.address,
        deadline: deadline
      };

      tx = await dexRouterWithWallet.buy(buyParams, { value: amountIn });
        
    } else if (marketData.market_type === "CURVE") {
      const bondingCurveRead = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, provider);
      const amountOut = await bondingCurveRead.getAmountOut(ca, amountIn, true);
      const minOut = (amountOut * (100n - BigInt(user.slippage))) / 100n;

      const buyParams = {
        amountOutMin: minOut,
        token: ca,
        to: user.address,
        deadline: deadline
      };

      const bondingCurveWrite = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, wallet);
      tx = await bondingCurveWrite.buy(buyParams, { value: amountIn });
    } else {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        "❌ Unsupported market type",
        createMainKeyboard()
      );
    }
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `⏳ Transaction submitted...\n🔗 Hash: ${tx.hash.substring(0, 20)}...`
    );

    await tx.wait();

    const existingPosition = user.positions.find(p => p.ca === ca);
    if (!existingPosition) {
      user.positions.push({ 
        ca, 
        amount: "?",
        buyPrice: marketData.price,
        buyTime: Date.now()
      });
    }
    dbSaveWallet(String(ctx.from.id), user);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ Buy Successful!
💰 Bought ${monAmount} MON worth
📊 Token: ${metadata?.symbol || ca.substring(0, 12) + "..."}
💵 Price: ${formatPrice(marketData.price)} MON
🎯 Slippage: ${user.slippage}%
📈 Market: ${marketData.market_type}
🔗 Hash: ${createTxLink(tx.hash)}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📊 View Position", "positions")],
          [Markup.button.callback("« Main Menu", "main_menu")]
        ])
      }
    );

  } catch (err) {
    console.error("Buy error:", err);
    
    let errorMsg = "❌ Buy failed: ";
    if (err.message.includes("UNSUPPORTED_OPERATION")) {
      errorMsg += "Contract connection error. Please try again.";
    } else if (err.message.includes("insufficient funds")) {
      errorMsg += "Insufficient MON balance for purchase + gas fees.";
    } else {
      errorMsg += err.message.substring(0, 100);
    }
    
    ctx.reply(errorMsg, createMainKeyboard());
  }
});

bot.command("help", requireAuth, (ctx) => {
  ctx.reply(`📋 NAD Bot Commands:

🔐 Authentication:
/auth <password> - Authenticate to use the bot

👤 Quick Actions:
/wallet - Wallet overview
/positions - View your positions
/buy <address> <amount> - Buy tokens
/sell <symbol> <percentage>% - Sell tokens

💡 Examples:
/buy 0x123...abc 0.1
/sell PEPE 50%
/sell baddog 25%

Use the inline buttons for the best experience!`, createMainKeyboard());
});

bot.command("wallet", requireAuth, async (ctx) => {
  let user = getWallet(ctx.from.id);
  if (!user) user = createWallet(ctx.from.id);

  const monBalance = await getMonBalance(user.address);
  
  const message = `👤 Your Wallet

🦀 Address: \`${user.address}\`
💰 Balance: ${formatPrice(monBalance)} MON
⚡ Auto-buy: ${user.autoBuy ? "ON ✅" : "OFF ❌"}
🎯 Slippage: ${user.slippage}%
💰 Default: ${user.defaultBuyAmount} MON`;

  ctx.reply(message, { 
    parse_mode: 'Markdown',
    ...createWalletKeyboard()
  });
});

bot.command("positions", requireAuth, async (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user || !user.positions.length) {
    return ctx.reply("📂 No positions yet\n\nStart trading to see your positions here!", 
      Markup.inlineKeyboard([[Markup.button.callback("« Back", "main_menu")]]));
  }

  let message = "📊 Your Positions:\n\n";
  const enrichedPositions = [];
  const validPositions = [];
  
  for (let i = 0; i < user.positions.length; i++) {
    const pos = user.positions[i];
    try {
      const { balance, decimals } = await getTokenBalance(pos.ca, user.address);
      const tokenBalance = parseFloat(ethers.formatUnits(balance, decimals));
      
      if (tokenBalance > 0) {
        const metadata = await getTokenMetadata(pos.ca);
        const marketData = await getMarketData(pos.ca);
        
        const symbol = metadata?.symbol || pos.ca.substring(0, 8) + "...";
        const price = marketData?.price ? formatPrice(marketData.price) : "N/A";
        const value = marketData?.price ? formatPrice(tokenBalance * parseFloat(marketData.price)) : "N/A";
        
        let pnlText = "";
        if (pos.buyPrice && marketData?.price) {
          const currentPrice = parseFloat(marketData.price);
          const buyPrice = parseFloat(pos.buyPrice);
          const pnl = ((currentPrice - buyPrice) / buyPrice) * 100;
          const pnlColor = pnl >= 0 ? "🟢" : "🔴";
          pnlText = ` ${pnlColor} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
        }
        
        const positionInfo = {
          ...pos,
          symbol,
          balance: tokenBalance,
          price,
          value,
          index: validPositions.length,
          decimals
        };
        
        validPositions.push(pos);
        enrichedPositions.push(positionInfo);
        
        message += `${enrichedPositions.length}. ${symbol}
💰 ${formatTokenAmount(balance, decimals)} tokens
💵 ${price} MON${pnlText}
📊 Value: ~${value} MON

`;
      }
    } catch (error) {
      console.error(`Error loading position ${pos.ca}:`, error);
    }
  }

  user.positions = validPositions;
  dbSaveWallet(String(ctx.from.id), user);

  if (enrichedPositions.length === 0) {
    message = "🔭 No active positions\n\nAll token balances are zero.";
    return ctx.reply(message, 
      Markup.inlineKeyboard([[Markup.button.callback("« Back", "main_menu")]]));
  }

  ctx.reply(message, createPositionKeyboard(enrichedPositions));
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  if (ctx) {
    try {
      ctx.reply('❌ An error occurred. Please try again.', createMainKeyboard());
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Bot startup function
async function startBot() {
  try {
    console.log('🚀 Starting Enhanced NAD Bot...');
    
    if (!process.env.BOT_TOKEN) {
      throw new Error('BOT_TOKEN environment variable is required');
    }
    if (!process.env.RPC_URL) {
      throw new Error('RPC_URL environment variable is required');
    }
    
    await bot.launch();
    console.log('✅ Enhanced NAD Bot is running successfully!');
    console.log('✨ Features: Auto-sell, DCA, Token Analysis, Top Holders, Clickable TX Links');
    console.log('⏱️ DCA & Auto-sell checks run every minute');
    
    process.once('SIGINT', () => {
      console.log('🛑 Received SIGINT, shutting down gracefully...');
      bot.stop('SIGINT');
    });
    
    process.once('SIGTERM', () => {
      console.log('🛑 Received SIGTERM, shutting down gracefully...');
      bot.stop('SIGTERM');
    });
    
  } catch (error) {
    console.error('❌ Failed to start bot:', error.message);
    if (error.message.includes('ETIMEDOUT')) {
      console.log('\n🌐 Network connection issue detected. Trying solutions:');
      console.log('1. Check your internet connection');
      console.log('2. Try using a VPN');
      console.log('3. Check if Telegram is blocked in your region');
      console.log('4. Wait a few minutes and try again');
    }
    process.exit(1);
  }
}

startBot();