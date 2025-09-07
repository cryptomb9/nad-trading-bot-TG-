import { Telegraf } from "telegraf";
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

// Import DB helpers (your new db.js)
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

// removed wallets.json file object — using DB now
let authenticatedUsers = new Set();

// helper wrappers that use your db.js
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

// NAD.fun API Functions
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
    return ethers.formatUnits(balance, decimals);
  } catch (error) {
    console.error("Error fetching token balance:", error);
    return "0";
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

// Read-only contract instances for quotes
const bondingCurveRouter = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, provider);
const dexRouter = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, provider);

bot.command("auth", (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("Usage: /auth <password>");
  }
  const password = args.slice(1).join(" ");
  
  if (password === "mbdagoat") {
    authenticatedUsers.add(ctx.from.id);
    ctx.reply("✅ Authentication successful! Welcome to NAD Bot.\n\nUse /help to see available commands.");
  } else {
    ctx.reply("❌ Invalid password. Access denied.");
  }
});

bot.start((ctx) => {
  ctx.reply(`🚀 Welcome to NAD Trading Bot!

🔐 This bot is password protected.
Use /auth <password> to authenticate and access all features.

💡 After authentication, use /help for commands list.`);
});

bot.command("debug", requireAuth, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2 || !ethers.isAddress(args[1])) {
    return ctx.reply("Usage: /debug <token_address>");
  }
  const ca = args[1];

  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  try {
    ctx.reply("🔍 Debugging token...");
    
    // Test API calls
    const metadata = await getTokenMetadata(ca);
    const marketData = await getMarketData(ca);
    
    console.log("Metadata:", metadata);
    console.log("Market data:", marketData);
    
    ctx.reply(`📊 Token Info:
Name: ${metadata?.name || "Unknown"}
Symbol: ${metadata?.symbol || "Unknown"}
Market Type: ${marketData?.market_type || "Unknown"}
Listed: ${metadata?.is_listing ? "Yes" : "No"}
Price: ${marketData?.price || "N/A"}`);
    
    // Test bonding curve router
    try {
      const testAmount = ethers.parseEther("0.001");
      const amountOut = await bondingCurveRouter.getAmountOut(ca, testAmount, true);
      ctx.reply(`✅ Bonding curve works: ${ethers.formatEther(amountOut)} tokens for 0.001 MON`);
    } catch (curveErr) {
      ctx.reply(`❌ Bonding curve failed: ${curveErr.message.substring(0, 100)}`);
      console.error("Bonding curve error:", curveErr);
    }
    
    // Test DEX router
    if (marketData?.market_type === "DEX") {
      try {
        const testAmount = ethers.parseEther("0.001");
        const amountOut = await dexRouter.getAmountOut(ca, testAmount, true);
        ctx.reply(`✅ DEX router quote: ${ethers.formatEther(amountOut)} tokens for 0.001 MON`);
      } catch (dexErr) {
        ctx.reply(`❌ DEX router failed: ${dexErr.message.substring(0, 100)}`);
        console.error("DEX router error:", dexErr);
      }
    }
    
  } catch (error) {
    ctx.reply("Debug failed: " + error.message);
    console.error("Debug error:", error);
  }
});

bot.command("help", requireAuth, (ctx) => {
  ctx.reply(`📋 NAD Bot Commands:

🔐 Authentication:
/auth <password> - Authenticate to use the bot

👤 Account:
/wallet - Show your wallet details
/balance - Show MON and token balances
/deposit - Show your deposit address
/export - Export private key (DELETE after saving!)

⚡ Trading:
/buy <token_address> <mon_amount> - Buy tokens
/sell <token_address> <token_amount> - Sell tokens
/positions - View your current positions

⚙️ Settings:
/autobuy - Toggle auto-buy on/off
/slippage <1-50> - Set slippage tolerance
/setdefault <amount> - Set default buy amount

📊 Information:
/debug <token_address> - Debug token trading capability
/tokeninfo <token_address> - Get detailed token information
/price <token_address> - Get current token price
/refresh - Refresh all balances
/help - Show this menu

🎁 Support:
/donate - Support the developer

Auto-buy: Paste any token address and it will auto-buy with your default amount if enabled.`);
});

bot.command("wallet", requireAuth, (ctx) => {
  let user = getWallet(ctx.from.id);
  if (!user) user = createWallet(ctx.from.id);

  ctx.reply(`👤 Your Wallet:

📍 Address: \`${user.address}\`
🔓 Status: Active
⚡ Auto-buy: ${user.autoBuy ? "ON ✅" : "OFF ❌"}
📊 Slippage: ${user.slippage}%
💰 Default buy: ${user.defaultBuyAmount} MON

⚠️ Use /export to get your private key if needed.`, { parse_mode: 'Markdown' });
});

bot.command("export", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  ctx.reply(`🔑 Private Key: \`${user.pk}\`

⚠️ SECURITY WARNING:
- Save this key securely
- DELETE this message immediately
- Never share with anyone
- This gives full access to your funds`, { parse_mode: 'Markdown' });
});

bot.command("balance", requireAuth, async (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  try {
    const monBalance = await getMonBalance(user.address);
    let message = `💰 Balance Overview:

🪙 MON: ${parseFloat(monBalance).toFixed(4)} MON`;

    if (user.positions.length > 0) {
      message += "\n\n🦄 Token Positions:";
      for (const pos of user.positions) {
        const balance = await getTokenBalance(pos.ca, user.address);
        if (parseFloat(balance) > 0) {
          const metadata = await getTokenMetadata(pos.ca);
          const symbol = metadata?.symbol || pos.ca.substring(0, 8) + "...";
          message += `\n📊 ${symbol}: ${parseFloat(balance).toFixed(4)}`;
        }
      }
    } else {
      message += "\n\n🔭 No token positions yet";
    }

    ctx.reply(message);
  } catch (error) {
    ctx.reply("❌ Failed to fetch balance: " + error.message);
  }
});

bot.command("deposit", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  ctx.reply(`🔥 Deposit Address:

\`${user.address}\`

Send MON to this address to fund your trading wallet.
⚠️ Only send MON on Monad Testnet!`, { parse_mode: 'Markdown' });
});

bot.command("autobuy", requireAuth, (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  user.autoBuy = !user.autoBuy;
  dbSaveWallet(String(ctx.from.id), user);
  ctx.reply(`⚡ Auto-buy is now: ${user.autoBuy ? "ON ✅" : "OFF ❌"}

${user.autoBuy ? `Auto-buy will purchase ${user.defaultBuyAmount} MON worth of any token address you paste.` : 'Paste token addresses to see detection without auto-buying.'}`);
});

bot.command("slippage", requireAuth, (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("⚠️ Enter a valid slippage % between 1 and 50\n\nExample: /slippage 15");
  }
  
  const value = args[1];
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  const num = parseFloat(value);
  if (isNaN(num) || num < 1 || num > 50) {
    return ctx.reply("⚠️ Enter a valid slippage % between 1 and 50\n\nExample: /slippage 15");
  }

  user.slippage = num;
  dbSaveWallet(String(ctx.from.id), user);
  ctx.reply(`✅ Slippage set to ${num}%`);
});

bot.command("setdefault", requireAuth, (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("⚠️ Enter a valid MON amount\n\nExample: /setdefault 0.5");
  }
  
  const amount = args[1];
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) {
    return ctx.reply("⚠️ Enter a valid MON amount\n\nExample: /setdefault 0.5");
  }

  user.defaultBuyAmount = amount;
  dbSaveWallet(String(ctx.from.id), user);
  ctx.reply(`✅ Default buy amount set to ${amount} MON`);
});

bot.command("tokeninfo", requireAuth, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2 || !ethers.isAddress(args[1])) {
    return ctx.reply("Usage: /tokeninfo <token_address>\n\nExample: /tokeninfo 0x123...abc");
  }
  const ca = args[1];

  try {
    const metadata = await getTokenMetadata(ca);
    const marketData = await getMarketData(ca);

    if (!metadata) {
      return ctx.reply("❌ Token not found or invalid address");
    }

    const createdDate = new Date(metadata.created_at * 1000).toLocaleString();
    
    let message = `📊 Token Information:

🏷️ Name: ${metadata.name}
🔤 Symbol: ${metadata.symbol}
📍 Address: ${ca.substring(0, 12)}...
👤 Creator: ${metadata.creator.substring(0, 12)}...
📅 Created: ${createdDate}
📝 Description: ${metadata.description || "No description"}

💹 Market Data:`;

    if (marketData) {
      message += `
💰 Current Price: ${parseFloat(marketData.price).toExponential(4)} MON
📈 Market Type: ${marketData.market_type}
🏪 Market ID: ${marketData.market_id.substring(0, 12)}...
📊 Total Supply: ${parseFloat(marketData.total_supply).toExponential(2)}`;
    }

    message += `
🔗 Listed: ${metadata.is_listing ? "Yes ✅" : "No ❌"}`;

    if (metadata.website) message += `\n🌐 Website: ${metadata.website}`;
    if (metadata.twitter) message += `\n🐦 Twitter: ${metadata.twitter}`;
    if (metadata.telegram) message += `\n💬 Telegram: ${metadata.telegram}`;

    ctx.reply(message);
  } catch (error) {
    ctx.reply("❌ Failed to fetch token info: " + error.message);
  }
});

bot.command("buy", requireAuth, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 3 || !ethers.isAddress(args[1])) {
    return ctx.reply("Usage: /buy <token_address> <mon_amount>\n\nExample: /buy 0x123...abc 0.1");
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

    const amountIn = ethers.parseEther(monAmount);
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    const statusMsg = await ctx.reply(`⏳ Processing buy order...
📊 ${monAmount} MON → ${ca.substring(0, 12)}...
🎯 Slippage: ${user.slippage}%
📈 Market: ${marketData.market_type}`);

    let tx;
    
    if (marketData.market_type === "DEX") {
      try {
        // Use read-only contract for quote
        const dexRouterRead = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, provider);
        const estimatedAmountOut = await dexRouterRead.getAmountOut(ca, amountIn, true);
        const minOut = (estimatedAmountOut * BigInt(100 - user.slippage)) / 100n;
        
        const buyParams = {
          amountOutMin: minOut,
          token: ca,
          to: user.address,
          deadline: deadline
        };

        // Use fresh contract with wallet for transaction
        const dexRouterWrite = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
        tx = await dexRouterWrite.buy(buyParams, { value: amountIn });
        
      } catch (dexError) {
        console.error("DEX buy error:", dexError);
        if (dexError.message.includes("0x4e969c58")) {
          return ctx.reply("❌ DEX buy failed: Token may have insufficient liquidity or may not be properly listed on DEX");
        }
        throw dexError;
      }
    } else if (marketData.market_type === "CURVE") {
      // Handle bonding curve trading
      const amountOut = await bondingCurveRouter.getAmountOut(ca, amountIn, true);
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
      return ctx.reply("❌ Unsupported market type");
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
      user.positions.push({ ca, amount: "?" });
    }
    dbSaveWallet(String(ctx.from.id), user);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ Buy Successful!
💰 Bought ${monAmount} MON worth
📊 Token: ${ca.substring(0, 12)}...
🎯 Slippage: ${user.slippage}%
📈 Market: ${marketData.market_type}
🔗 Hash: ${tx.hash.substring(0, 20)}...`
    );

  } catch (err) {
    console.error("Buy error:", err);
    ctx.reply("❌ Buy failed: " + err.message.substring(0, 100));
  }
});

bot.command("sell", requireAuth, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 3 || !ethers.isAddress(args[1])) {
    return ctx.reply("Usage: /sell <token_address> <token_amount>\n\nExample: /sell 0x123...abc 100");
  }
  const [cmd, ca, amountTokens] = args;

  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  const tokenAmountNum = parseFloat(amountTokens);
  if (isNaN(tokenAmountNum) || tokenAmountNum <= 0) {
    return ctx.reply("❌ Invalid token amount. Please enter a positive number.");
  }

  const wallet = new ethers.Wallet(user.pk, provider);
  const token = new ethers.Contract(ca, erc20Abi, wallet);

  try {
    const marketData = await getMarketData(ca);
    if (!marketData) {
      return ctx.reply("❌ Token not found or not tradeable");
    }

    const decimals = await token.decimals();
    const amountIn = ethers.parseUnits(amountTokens, decimals);
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    const statusMsg = await ctx.reply(`⏳ Processing sell order...
📊 ${amountTokens} tokens → MON
🎯 Slippage: ${user.slippage}%
📈 Market: ${marketData.market_type}`);

    // Approve tokens first
    const routerAddress = marketData.market_type === "CURVE" ? CONTRACTS.BONDING_CURVE_ROUTER : CONTRACTS.DEX_ROUTER;
    const approveTx = await token.approve(routerAddress, amountIn);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      "⏳ Approving tokens..."
    );

    await approveTx.wait();

    let tx;
    
    if (marketData.market_type === "DEX") {
      // Use read-only contract for quote
      const dexRouterRead = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, provider);
      const estimatedAmountOut = await dexRouterRead.getAmountOut(ca, amountIn, false);
      const minOut = (estimatedAmountOut * BigInt(100 - user.slippage)) / 100n;
      
      const sellParams = {
        amountIn: amountIn,
        amountOutMin: minOut,
        token: ca,
        to: user.address,
        deadline: deadline
      };

      const dexRouterWrite = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
      tx = await dexRouterWrite.sell(sellParams);
    } else if (marketData.market_type === "CURVE") {
      const sellParams = {
        amountIn: amountIn,
        amountOutMin: 0,
        token: ca,
        to: user.address,
        deadline: deadline
      };

      const bondingCurveWrite = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, wallet);
      tx = await bondingCurveWrite.sell(sellParams);
    } else {
      return ctx.reply("❌ Unsupported market type");
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `⏳ Transaction submitted...\n🔗 Hash: ${tx.hash.substring(0, 20)}...`
    );

    await tx.wait();

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ Sell Successful!
📊 Sold ${amountTokens} tokens
💰 Token: ${ca.substring(0, 12)}...
🎯 Slippage: ${user.slippage}%
📈 Market: ${marketData.market_type}
🔗 Hash: ${tx.hash.substring(0, 20)}...`
    );

  } catch (err) {
    console.error("Sell error:", err);
    ctx.reply("❌ Sell failed: " + err.message.substring(0, 100));
  }
});

bot.command("positions", requireAuth, async (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user || !user.positions.length) {
    return ctx.reply("📂 No positions yet\n\nStart trading with /buy command!");
  }

  let reply = "📊 Your Positions:\n\n";
  let hasPositions = false;

  for (const pos of user.positions) {
    try {
      const balance = await getTokenBalance(pos.ca, user.address);
      if (parseFloat(balance) > 0) {
        const metadata = await getTokenMetadata(pos.ca);
        const marketData = await getMarketData(pos.ca);
        
        const symbol = metadata?.symbol || pos.ca.substring(0, 8) + "...";
        const price = marketData?.price ? parseFloat(marketData.price).toExponential(4) : "N/A";
        
        reply += `🪙 ${symbol} (${pos.ca.substring(0, 12)}...)
💰 Balance: ${parseFloat(balance).toFixed(4)}
💹 Price: ${price} MON
📈 Market: ${marketData?.market_type || "Unknown"}

`;
        hasPositions = true;
      }
    } catch (error) {
      reply += `❌ ${pos.ca.substring(0, 12)}... (Error loading)\n\n`;
    }
  }

  if (!hasPositions) {
    reply = "🔭 No active positions\n\nAll token balances are zero.";
  }

  ctx.reply(reply);
});

bot.command("price", requireAuth, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2 || !ethers.isAddress(args[1])) {
    return ctx.reply("Usage: /price <token_address>\n\nExample: /price 0x123...abc");
  }
  const ca = args[1];

  try {
    const marketData = await getMarketData(ca);
    const metadata = await getTokenMetadata(ca);

    if (!marketData || !metadata) {
      return ctx.reply("❌ Token not found or not tradeable");
    }

    ctx.reply(`📊 ${metadata.symbol} Price Information:

💰 Current Price: ${parseFloat(marketData.price).toExponential(4)} MON
📈 Market Type: ${marketData.market_type}
🏪 Market Address: ${marketData.market_id.substring(0, 12)}...
📊 Total Supply: ${parseFloat(marketData.total_supply).toExponential(2)}

💡 Use /buy or /sell to trade this token.`);
  } catch (error) {
    ctx.reply("❌ Could not fetch price info: " + error.message);
  }
});

bot.command("refresh", requireAuth, async (ctx) => {
  const user = getWallet(ctx.from.id);
  if (!user) return ctx.reply("❌ No wallet found, use /wallet first");

  const msg = await ctx.reply("🔄 Refreshing balances...");
  
  try {
    const monBalance = await getMonBalance(user.address);
    let balanceText = `💰 Updated Balances:

🪙 MON: ${parseFloat(monBalance).toFixed(4)} MON`;

    if (user.positions.length > 0) {
      balanceText += "\n\n🦄 Token Balances:";
      for (const pos of user.positions) {
        const balance = await getTokenBalance(pos.ca, user.address);
        if (parseFloat(balance) > 0) {
          const metadata = await getTokenMetadata(pos.ca);
          const symbol = metadata?.symbol || pos.ca.substring(0, 8) + "...";
          balanceText += `\n📊 ${symbol}: ${parseFloat(balance).toFixed(4)}`;
        }
      }
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      balanceText
    );
  } catch (error) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      "❌ Failed to refresh balances: " + error.message
    );
  }
});

bot.command("donate", (ctx) => {
  const donateAddress = process.env.DONATE_ADDRESS;
  if (!donateAddress) {
    return ctx.reply("🙏 Support NAD Bot Development!\n\nDonate address not configured. Please contact the developer.");
  }

  ctx.reply(`🙏 Support NAD Bot Development:

💰 MON Address:
\`${donateAddress}\`

Your donations help keep this bot running and improving!

Thank you for your support! 🚀`, { parse_mode: 'Markdown' });
});

// Auto-buy functionality for pasted token addresses
bot.on("text", requireAuth, async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text.startsWith("0x") || text.length !== 42 || !ethers.isAddress(text)) return;

  const user = getWallet(ctx.from.id);
  if (!user) return;

  const metadata = await getTokenMetadata(text);
  const marketData = await getMarketData(text);

  if (!metadata) {
    return ctx.reply(`❌ Token not found: ${text.substring(0, 12)}...`);
  }

  if (!user.autoBuy) {
    return ctx.reply(`🔍 Token Detected: ${metadata.symbol}

🏷️ Name: ${metadata.name}
📍 Address: ${text.substring(0, 12)}...
📈 Market: ${marketData?.market_type || "Unknown"}
💰 Price: ${marketData?.price ? parseFloat(marketData.price).toExponential(4) : "N/A"} MON

⚡ Auto-buy is OFF
Use /autobuy to enable auto-purchasing
Or use /buy ${text.substring(0, 12)}... <amount> to buy manually`);
  }

  if (!marketData) {
    return ctx.reply(`❌ Token ${metadata.symbol} is not tradeable yet`);
  }

  const wallet = new ethers.Wallet(user.pk, provider);
  
  try {
    const amountIn = ethers.parseEther(user.defaultBuyAmount);
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    const statusMsg = await ctx.reply(`⚡ Auto-buy triggered!
🏷️ Token: ${metadata.symbol}
📊 ${user.defaultBuyAmount} MON → ${text.substring(0, 12)}...
🎯 Slippage: ${user.slippage}%
📈 Market: ${marketData.market_type}`);

    let tx;
    
    if (marketData.market_type === "DEX") {
      try {
        // Use read-only contract for quote
        const dexRouterRead = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, provider);
        const estimatedAmountOut = await dexRouterRead.getAmountOut(text, amountIn, true);
        const minOut = (estimatedAmountOut * BigInt(100 - user.slippage)) / 100n;
        
        const buyParams = {
          amountOutMin: minOut,
          token: text,
          to: user.address,
          deadline: deadline
        };

        // Use fresh contract with wallet for transaction
        const dexRouterWrite = new ethers.Contract(CONTRACTS.DEX_ROUTER, dexRouterAbi, wallet);
        tx = await dexRouterWrite.buy(buyParams, { value: amountIn });
        
      } catch (dexError) {
        console.error("DEX auto-buy error:", dexError);
        if (dexError.message.includes("0x4e969c58")) {
          return ctx.reply("❌ Auto-buy failed: Token may have insufficient liquidity on DEX");
        }
        throw dexError;
      }
    } else if (marketData.market_type === "CURVE") {
      const amountOut = await bondingCurveRouter.getAmountOut(text, amountIn, true);
      const minOut = (amountOut * BigInt(100 - user.slippage)) / 100n;

      const buyParams = {
        amountOutMin: minOut,
        token: text,
        to: user.address,
        deadline: deadline
      };

      const bondingCurveWrite = new ethers.Contract(CONTRACTS.BONDING_CURVE_ROUTER, bondingCurveRouterAbi, wallet);
      tx = await bondingCurveWrite.buy(buyParams, { value: amountIn });
    } else {
      return ctx.reply("❌ Unsupported market type for auto-buy");
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `⏳ Auto-buy processing...
🔗 Hash: ${tx.hash.substring(0, 20)}...`
    );

    await tx.wait();

    const existingPosition = user.positions.find(p => p.ca === text);
    if (!existingPosition) {
      user.positions.push({ ca: text, amount: "?" });
    }
    dbSaveWallet(String(ctx.from.id), user);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ Auto-buy Successful!
🏷️ Token: ${metadata.symbol}
💰 Bought ${user.defaultBuyAmount} MON worth
📊 Token: ${text.substring(0, 12)}...
📈 Market: ${marketData.market_type}
🔗 Hash: ${tx.hash.substring(0, 20)}...`
    );

  } catch (err) {
    console.error(`Auto-buy failed for user ${ctx.from.id}:`, err);
    ctx.reply(`❌ Auto-buy failed: ${err.message.substring(0, 100)}`);
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  if (ctx) {
    try {
      ctx.reply('❌ An error occurred. Please try again.');
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

async function startBot() {
  try {
    console.log('🚀 Starting NAD Bot...');
    
    if (!process.env.BOT_TOKEN) {
      throw new Error('BOT_TOKEN environment variable is required');
    }
    if (!process.env.RPC_URL) {
      throw new Error('RPC_URL environment variable is required');
    }
    
    await bot.launch();
    console.log('✅ NAD Bot is running successfully!');
    
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
