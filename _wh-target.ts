import { PgliteVaultImpl } from "./packages/vault/src/pglite-vault.ts";
import { defaultMasterKey } from "./packages/vault/src/master-key.ts";
import { appendFileSync } from "node:fs";
const SC = "/tmp/claude-1003/-home-milady/651d6a2b-bcea-4c51-b766-73d2e3d70254/scratchpad";
const vault = new PgliteVaultImpl({ dataDir: SC + "/vsnap", legacyStorePath: SC + "/vault.json", masterKey: defaultMasterKey(), auditPath: SC + "/vaudit.jsonl" });
const token = (await vault.get("DISCORD_API_TOKEN")).trim();
const H = { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (eliza,1.0)" };
const targets = ["1490836448755060921","1491547592943730890","1491632351539626165"]; // General, test, fresh-test
for (const ch of targets) {
  const res = await fetch(`https://discord.com/api/v10/channels/${ch}/webhooks`, { method: "POST", headers: H, body: JSON.stringify({ name: "eliza-e2e2" }) });
  if (res.ok) { const wh = await res.json(); const url = `https://discord.com/api/webhooks/${wh.id}/${wh.token}`; appendFileSync("/home/milady/.cache/wh-live.txt", url + "\n"); console.log(`MINTED in channel ${ch}; saved`); process.exit(0); }
  else console.log(`ch ${ch}: ${res.status} ${(await res.text()).slice(0,60)}`);
}
console.log("none");
