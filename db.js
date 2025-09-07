import Database from "better-sqlite3";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const db = new Database("wallets.db");

// Create wallets table
db.prepare(`
  CREATE TABLE IF NOT EXISTS wallets (
    userId TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    encryptedPk TEXT NOT NULL,
    autoBuy INTEGER DEFAULT 0,
    slippage INTEGER DEFAULT 10,
    defaultBuyAmount TEXT DEFAULT '0.1'
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    ca TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES wallets(userId)
  )
`).run();

const SECRET_KEY = Buffer.from(process.env.ENCRYPTION_KEY, "hex"); // 32 bytes key

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", SECRET_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data) {
  const [ivHex, tagHex, encHex] = data.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encryptedText = Buffer.from(encHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", SECRET_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString("utf8");
}

export function saveWallet(userId, wallet) {
  db.prepare(`
    INSERT INTO wallets (userId, address, encryptedPk, autoBuy, slippage, defaultBuyAmount)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET
      address=excluded.address,
      encryptedPk=excluded.encryptedPk,
      autoBuy=excluded.autoBuy,
      slippage=excluded.slippage,
      defaultBuyAmount=excluded.defaultBuyAmount
  `).run(
    userId,
    wallet.address,
    encrypt(wallet.pk),
    wallet.autoBuy ? 1 : 0,
    wallet.slippage,
    wallet.defaultBuyAmount
  );

  // Clear old positions & reinsert
  db.prepare(`DELETE FROM positions WHERE userId = ?`).run(userId);
  for (const pos of wallet.positions) {
    db.prepare(`INSERT INTO positions (userId, ca) VALUES (?, ?)`).run(userId, pos.ca);
  }
}

export function getWallet(userId) {
  const row = db.prepare(`SELECT * FROM wallets WHERE userId = ?`).get(userId);
  if (!row) return null;

  const positions = db.prepare(`SELECT ca FROM positions WHERE userId = ?`).all(userId);

  return {
    address: row.address,
    pk: decrypt(row.encryptedPk),
    autoBuy: !!row.autoBuy,
    slippage: row.slippage,
    positions,
    defaultBuyAmount: row.defaultBuyAmount
  };
}
