import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity } from "@metaplex-foundation/umi";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required env var: ${name}`);
  return value.trim();
}

function loadSecretBytes(raw: string): Uint8Array {
  const value = raw.trim();
  if (value.startsWith("[")) return Uint8Array.from(JSON.parse(value));
  if (fs.existsSync(value)) return loadSecretBytes(fs.readFileSync(value, "utf8"));
  return bs58.decode(value);
}

const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const file = process.argv[2] ?? "clawd-registration.json";

const umi = createUmi(rpcUrl).use(irysUploader());
const keypair = umi.eddsa.createKeypairFromSecretKey(loadSecretBytes(mustEnv("WALLET_SECRET_KEY")));
umi.use(keypairIdentity(keypair));

async function main() {
  const fullPath = path.resolve(file);
  const json = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const uri = await umi.uploader.uploadJson(json);
  console.log(uri);
  fs.writeFileSync(`${fullPath}.uri.txt`, uri);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
