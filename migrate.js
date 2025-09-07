import fs from "fs";
import { saveWallet } from "./db.js";

if (fs.existsSync("wallets.json")) {
  const data = JSON.parse(fs.readFileSync("wallets.json", "utf8"));
  for (const [userId, wallet] of Object.entries(data)) {
    saveWallet(userId, wallet);
  }
  console.log("✅ Migration complete: wallets.json → wallets.db");
}
