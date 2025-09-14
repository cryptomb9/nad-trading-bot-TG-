import { Telegraf, Markup } from "telegraf";
import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";

// Import all ABIs
import erc20Abi from "./abis/erc20.json" with { type: "json" };
import bondingCurveRouterAbi from "./abis/bundingcurverouter.json" with { type: "json" };
import bondingCurveAbi from "./abis/bundingcurve.json" with { type: "json" };
import dexRouterAbi from "./abis/dexrouter.json" with { type: "json" };

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// Import DB helpers
import { getWallet as dbGetWallet, saveWallet as dbSaveWallet } from "./db.js";

// NAD.fun Contract Addresses
const CONTRACTS = {
  BONDING_CURVE: "0x52D34d8536350Cd997bCBD0b9E9d722452f341F5",
  BONDING_CURVE_ROUTER: "0x4F5A3518F082275edf59026f72B66AC2838c0414",
  DEX_ROUTER: "0x4FBDC27FAE5f99E7B09590bEc8Bf20481FCf9551",
  FACTORY: "0x961235a9020B05C44DF1026D956D1F4D78014276",
  WMON: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701"
};

// API Base URLs
const API_BASE = "https://testnet-v3-api.nad.fun";
const WS_BASE = "wss://testnet-v3-ws.nad.fun/wss";

let authenticatedUsers = new Set();
let pendingSells = new Map(); // Store pending sell operations

// Helper functions
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

function createMainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💰 Wallet", "wallet"), Markup.button.callback("📊 Positions", "positions")],
    [Markup.button.callback("⚙️ Settings", "settings"), Markup.button.callback("📈 Buy", "buy_menu")],
    [Markup.button.callback("📉 Sell", "sell_menu"), Markup.button.callback("🔄 Refresh", "refresh")]
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

// Enhanced helper wrappers
function createWallet(userId) {
  const wallet = ethers.Wallet.createRandom();
  const data = {
    address: wallet.address,
    pk: wallet.privateKey,
    autoBuy: false,
    slippage: 10,
    positions: [],
    defaultBuyAmount: "0.1"
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

// API Functions
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

// FIXED executeSell function
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
    const sellAmount = (BigInt(balance) * BigInt(percentage)) / 100n;
    
    if (sellAmount === 0n) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        "❌ No tokens to sell",
        Markup.inlineKeyboard([[Markup.button.callback("« Back", "positions")]])
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
    const routerAddress = marketData.market_type === "CURVE" ? CONTRACTS.BONDING_CURVE_ROUTER : CONTRACTS.DEX_ROUTER;
    
    const approveTx = await token.approve(routerAddress, sellAmount);
    await approveTx.wait();
    
    let tx;
    if (marketData.market_type === "DEX") {
      const dexRouterRead = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, provider);
      const quoteData = await dexRouterRead.getAmountOut(pos.ca, sellAmount, false);
      const minOut = (quoteData * BigInt(100 - user.slippage)) / 100n;
      
      const sellParams = {
        amountIn: sellAmount,
        amountOutMin: minOut,
        token: pos.ca,
        to: user.address,
        deadline: deadline
      };

      const dexRouterWrite = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
      tx = await dexRouterWrite.sell(sellParams);
    } else if (marketData.market_type === "CURVE") {
      const sellParams = {
        amountIn: sellAmount,
        amountOutMin: 0,
        token: pos.ca,
        to: user.address,
        deadline: deadline
      };

      const bondingCurveWrite = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, wallet);
      tx = await bondingCurveWrite.sell(sellParams);
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `⏳ Sell submitted! Hash: ${tx.hash.substring(0, 20)}...`
    );

    tx.wait().then(() => {
      ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `✅ Sell Complete!
🎯 Sold ${percentage}% of ${metadata?.symbol || "tokens"}
💰 ${formatTokenAmount(sellAmount, decimals)} tokens
🔗 ${tx.hash.substring(0, 20)}...`,
        Markup.inlineKeyboard([[Markup.button.callback("📊 Positions", "positions"), Markup.button.callback("« Menu", "main_menu")]])
      );
    }).catch(err => {
      ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `⚠️ Sell submitted but confirmation failed. Check hash: ${tx.hash.substring(0, 20)}...`
      );
    });

  } catch (err) {
    console.error("Sell error:", err);
    const errorMsg = `❌ Sell failed: ${err.message.substring(0, 100)}`;
    if (ctx.editMessageText) {
      ctx.editMessageText(errorMsg, Markup.inlineKeyboard([[Markup.button.callback("« Back", "positions")]]));
    } else {
      ctx.reply(errorMsg, Markup.inlineKeyboard([[Markup.button.callback("« Back", "positions")]]));
    }
  }
}

// FIXED executeAutoBuy function
async function executeAutoBuy(ctx, tokenAddress, metadata, marketData, user) {
  const wallet = new ethers.Wallet(user.pk, provider);
  
  try {
    const amountIn = ethers.parseEther(user.defaultBuyAmount);
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    const statusMsg = await ctx.reply(`⚡ Auto-buy executing...
🏷️ Token: ${metadata.symbol}
💰 Amount: ${user.defaultBuyAmount} MON
🎯 Slippage: ${user.slippage}%`, 
      Markup.inlineKeyboard([[Markup.button.callback("⏹️ Cancel", "cancel_buy")]]));

    let tx;
    
    if (marketData.market_type === "DEX") {
      const dexRouterRead = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, provider);
      const estimatedAmountOut = await dexRouterRead.getAmountOut(tokenAddress, amountIn, true);
      const minOut = (estimatedAmountOut * BigInt(100 - user.slippage)) / 100n;
      
      const buyParams = {
        amountOutMin: minOut,
        token: tokenAddress,
        to: user.address,
        deadline: deadline
      };

      const dexRouterWrite = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
      tx = await dexRouterWrite.buy(buyParams, { value: amountIn });
      
    } else if (marketData.market_type === "CURVE") {
      const bondingCurveRead = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, provider);
      const amountOut = await bondingCurveRead.getAmountOut(tokenAddress, amountIn, true);
      const minOut = (amountOut * BigInt(100 - user.slippage)) / 100n;

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
🔗 Hash: ${tx.hash.substring(0, 20)}...`,
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
    ctx.reply(`❌ Auto-buy failed: ${err.message.substring(0, 100)}`, 
      Markup.inlineKeyboard([[Markup.button.callback("« Main Menu", "main_menu")]]));
  }
}

// Contract instances
const bondingCurveRouter = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, provider);
const dexRouter = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, provider);

// Commands
bot.command("auth", (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("Usage: /auth <password>");
  }
  const password = args.slice(1).join(" ");
  
  if (password === "mbdagoat") {
    authenticatedUsers.add(ctx.from.id);
    ctx.reply("✅ Welcome to NAD Bot!", createMainKeyboard());
  } else {
    ctx.reply("❌ Invalid password. Access denied.");
  }
});

bot.start((ctx) => {
  ctx.reply(`🚀 Welcome to NAD Trading Bot!

🔐 This bot is password protected.
Use /auth <password> to authenticate and access all features.`, 
    Markup.inlineKeyboard([[Markup.button.callback("🔐 Authenticate", "need_auth")]]));
});

// Callback query handlers
bot.action("need_auth", (ctx) => {
  ctx.editMessageText("Please use /auth <password> to authenticate");
});

bot.action("main_menu", requireAuth, (ctx) => {
  ctx.editMessageText("🚀 NAD Trading Bot", createMainKeyboard());
});

bot.action("wallet", requireAuth, async (ctx) => {
  let user = getWallet(ctx.from.id);
  if (!user) user = createWallet(ctx.from.id);

  const monBalance = await getMonBalance(user.address);
  
  const message = `💤 Your Wallet

🏦 Address: \`${user.address}\`
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

  for (let i = 0; i < user.positions.length; i++) {
    const pos = user.positions[i];
    try {
      const { balance, decimals } = await getTokenBalance(pos.ca, user.address);
      if (parseFloat(ethers.formatUnits(balance, decimals)) > 0) {
        const metadata = await getTokenMetadata(pos.ca);
        const marketData = await getMarketData(pos.ca);
        
        const symbol = metadata?.symbol || pos.ca.substring(0, 8) + "...";
        const tokenBalance = parseFloat(ethers.formatUnits(balance, decimals));
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
        
        message += `${i + 1}. ${symbol}
💰 ${formatTokenAmount(balance, decimals)} tokens
💵 $${price} MON${pnlText}
📊 Value: ~${value} MON

`;
        
        enrichedPositions.push({
          ...pos,
          symbol,
          balance: tokenBalance,
          price,
          value,
          index: i
        });
      }
    } catch (error) {
      console.error(`Error loading position ${pos.ca}:`, error);
    }
  }

  if (enrichedPositions.length === 0) {
    message = "📭 No active positions\n\nAll token balances are zero.";
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

🏦 Address: ${pos.ca.substring(0, 12)}...
💰 Balance: ${formatTokenAmount(balance, decimals)}
💵 Price: ${price} MON
${pnlText}

Choose sell amount:`;

  ctx.editMessageText(message, createSellPercentageKeyboard(positionIndex));
});

// FIXED: Handle percentage sells
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
  pendingSells.set(ctx.from.id, { type: 'custom', positionIndex: parseInt(positionIndex) });
  ctx.editMessageText("💰 Enter the amount of tokens to sell:\n\nReply with just the number (e.g., 1000000)");
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
      await executeSell({ reply: (text, markup) => ctx.reply(text, markup), chat: ctx.chat }, positionIndex, percentage);
    } else {
      ctx.reply("❌ Invalid percentage. Use 1-100%");
    }
  } else {
    ctx.reply("🚧 Specific amount selling will be implemented soon. Use percentages for now.");
  }
});

// FIXED: Enhanced text handler
bot.on("text", requireAuth, async (ctx) => {
  const text = ctx.message.text.trim();
  
  if (pendingSells.has(ctx.from.id)) {
    const pendingAction = pendingSells.get(ctx.from.id);
    
    if (pendingAction.type === 'slippage') {
      const slippage = parseFloat(text);
      if (isNaN(slippage) || slippage < 1 || slippage > 50) {
        return ctx.reply("❌ Invalid slippage. Enter a number between 1 and 50.");
      }
      
      const user = getWallet(ctx.from.id);
      user.slippage = slippage;
      dbSaveWallet(String(ctx.from.id), user);
      pendingSells.delete(ctx.from.id);
      
      return ctx.reply(`✅ Slippage set to ${slippage}%`, createSettingsKeyboard(user));
    }
    
    if (pendingAction.type === 'default_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply("❌ Invalid amount. Enter a positive number.");
      }
      
      const user = getWallet(ctx.from.id);
      user.defaultBuyAmount = text;
      dbSaveWallet(String(ctx.from.id), user);
      pendingSells.delete(ctx.from.id);
      
      return ctx.reply(`✅ Default buy amount set to ${text} MON`, createSettingsKeyboard(user));
    }
    
    if (pendingAction.type === 'custom') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply("❌ Invalid amount. Please enter a valid number.");
      }
      
      pendingSells.delete(ctx.from.id);
      await executeSell(ctx, pendingAction.positionIndex, 100);
      return;
    }
  }

  if (text.startsWith("0x") && text.length === 42 && ethers.isAddress(text)) {
    const user = getWallet(ctx.from.id);
    if (!user) return;

    const metadata = await getTokenMetadata(text);
    const marketData = await getMarketData(text);

    if (!metadata) {
      return ctx.reply(`❌ Token not found: ${text.substring(0, 12)}...`, createMainKeyboard());
    }

    const price = marketData?.price ? formatPrice(marketData.price) : "N/A";
    
    if (!user.autoBuy) {
      return ctx.reply(`🔍 Token Detected: ${metadata.symbol}

🏷️ Name: ${metadata.name}
📍 Address: ${text.substring(0, 12)}...
📈 Market: ${marketData?.market_type || "Unknown"}
💰 Price: ${price} MON

⚡ Auto-buy is OFF`, 
        Markup.inlineKeyboard([
          [Markup.button.callback(`⚡ Buy ${user.defaultBuyAmount} MON`, `quick_buy_${text}`)],
          [Markup.button.callback("⚙️ Enable Auto-buy", "toggle_autobuy"), Markup.button.callback("« Back", "main_menu")]
        ]));
    }

    if (!marketData) {
      return ctx.reply(`❌ Token ${metadata.symbol} is not tradeable yet`, createMainKeyboard());
    }

    await executeAutoBuy(ctx, text, metadata, marketData, user);
  }
});

// Quick buy from token detection
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

// Additional action handlers
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
    ctx.editMessageText("🚀 NAD Trading Bot", createMainKeyboard());
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
  pendingSells.set(ctx.from.id, { type: 'slippage' });
});

bot.action("set_default", requireAuth, (ctx) => {
  ctx.editMessageText("💰 Enter default buy amount in MON:\n\nReply with just the number (e.g., 0.5)");
  pendingSells.set(ctx.from.id, { type: 'default_amount' });
});

bot.action("refresh_wallet", requireAuth, async (ctx) => {
  let user = getWallet(ctx.from.id);
  if (!user) user = createWallet(ctx.from.id);

  const monBalance = await getMonBalance(user.address);
  
  const message = `💤 Your Wallet

🏦 Address: \`${user.address}\`
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

// Enhanced buy command with better UX
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
      Markup.inlineKeyboard([[Markup.button.callback("⏹️ Cancel", "cancel_buy")]]));

    let tx;
    
    if (marketData.market_type === "DEX") {
      try {
        const dexRouterRead = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, provider);
        const estimatedAmountOut = await dexRouterRead.getAmountOut(ca, amountIn, true);
        const minOut = (estimatedAmountOut * BigInt(100 - user.slippage)) / 100n;
        
        const buyParams = {
          amountOutMin: minOut,
          token: ca,
          to: user.address,
          deadline: deadline
        };

        const dexRouterWrite = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
        tx = await dexRouterWrite.buy(buyParams, { value: amountIn });
        
      } catch (dexError) {
        console.error("DEX buy error:", dexError);
        if (dexError.message.includes("0x4e969c58")) {
          return ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            undefined,
            "❌ DEX buy failed: Token may have insufficient liquidity or may not be properly listed on DEX",
            createMainKeyboard()
          );
        }
        throw dexError;
      }
    } else if (marketData.market_type === "CURVE") {
      const bondingCurveRead = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, provider);
      const amountOut = await bondingCurveRead.getAmountOut(ca, amountIn, true);
      const minOut = (amountOut * BigInt(100 - user.slippage)) / 100n;

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
🔗 Hash: ${tx.hash.substring(0, 20)}...`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 View Position", "positions")],
        [Markup.button.callback("« Main Menu", "main_menu")]
      ])
    );

  } catch (err) {
    console.error("Buy error:", err);
    ctx.reply(`❌ Buy failed: ${err.message.substring(0, 100)}`, createMainKeyboard());
  }
});

// Additional commands for better UX
bot.command("help", requireAuth, (ctx) => {
  ctx.reply(`🔋 NAD Bot Commands:

🔐 Authentication:
/auth <password> - Authenticate to use the bot

💤 Quick Actions:
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
  
  const message = `💤 Your Wallet

🏦 Address: \`${user.address}\`
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

  for (let i = 0; i < user.positions.length; i++) {
    const pos = user.positions[i];
    try {
      const { balance, decimals } = await getTokenBalance(pos.ca, user.address);
      if (parseFloat(ethers.formatUnits(balance, decimals)) > 0) {
        const metadata = await getTokenMetadata(pos.ca);
        const marketData = await getMarketData(pos.ca);
        
        const symbol = metadata?.symbol || pos.ca.substring(0, 8) + "...";
        const tokenBalance = parseFloat(ethers.formatUnits(balance, decimals));
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
        
        message += `${i + 1}. ${symbol}
💰 ${formatTokenAmount(balance, decimals)} tokens
💵 ${price} MON${pnlText}
📊 Value: ~${value} MON

`;
        
        enrichedPositions.push({
          ...pos,
          symbol,
          balance: tokenBalance,
          price,
          value,
          index: i
        });
      }
    } catch (error) {
      console.error(`Error loading position ${pos.ca}:`, error);
    }
  }

  if (enrichedPositions.length === 0) {
    message = "📭 No active positions\n\nAll token balances are zero.";
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

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

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
    console.log('✨ Features: Fixed contract calls, proper error handling, enhanced UX');
    
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