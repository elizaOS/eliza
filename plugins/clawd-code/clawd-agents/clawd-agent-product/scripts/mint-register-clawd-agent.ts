import "dotenv/config";
import fs from "node:fs";
import bs58 from "bs58";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity } from "@metaplex-foundation/umi";
import { create, createCollection, fetchAsset, findAssetSignerPda, mplCore } from "@metaplex-foundation/mpl-core";
import {
  mplAgentIdentity,
  mplAgentTools,
  registerIdentityV1,
  registerExecutiveV1,
  delegateExecutionV1,
  findAgentIdentityV1Pda,
  findExecutiveProfileV1Pda,
  safeFetchAgentIdentityV1,
} from "@metaplex-foundation/mpl-agent-registry";

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required env var: ${name}`);
  return value.trim();
}

function loadSecretBytes(raw: string): Uint8Array {
  const value = raw.trim();
  if (value.startsWith("[")) return Uint8Array.from(JSON.parse(value));
  if (fs.existsSync(value)) {
    const fromFile = fs.readFileSync(value, "utf8").trim();
    return loadSecretBytes(fromFile);
  }
  return bs58.decode(value);
}

const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const registrationUri = mustEnv("REGISTRATION_URI");
const collectionUri = process.env.COLLECTION_URI ?? "https://x402.wtf/assets/clawd-collection.json";
const assetUri = process.env.ASSET_URI ?? "https://x402.wtf/assets/clawd-agent.json";

const umi = createUmi(rpcUrl)
  .use(mplCore())
  .use(mplAgentIdentity())
  .use(mplAgentTools());

const keypair = umi.eddsa.createKeypairFromSecretKey(loadSecretBytes(mustEnv("WALLET_SECRET_KEY")));
umi.use(keypairIdentity(keypair));

async function main() {
  console.log("CLAWD mint/register starting");
  console.log("Wallet:", umi.identity.publicKey.toString());
  console.log("RPC:", rpcUrl);
  console.log("Registration URI:", registrationUri);

  const collection = generateSigner(umi);
  await createCollection(umi, {
    collection,
    name: "CLAWD Agents",
    uri: collectionUri,
  }).sendAndConfirm(umi);
  console.log("Collection:", collection.publicKey.toString());

  const asset = generateSigner(umi);
  await create(umi, {
    asset,
    name: "CLAWD",
    uri: assetUri,
    collection,
  }).sendAndConfirm(umi);
  console.log("Agent asset:", asset.publicKey.toString());

  await registerIdentityV1(umi, {
    asset: asset.publicKey,
    collection: collection.publicKey,
    agentRegistrationUri: registrationUri,
  }).sendAndConfirm(umi);
  console.log("Agent identity registered");

  const agentIdentityPda = findAgentIdentityV1Pda(umi, { asset: asset.publicKey });
  const identity = await safeFetchAgentIdentityV1(umi, agentIdentityPda);
  if (!identity) throw new Error("Identity registration verification failed.");
  console.log("Agent identity PDA:", agentIdentityPda.toString());

  try {
    await registerExecutiveV1(umi, { payer: umi.identity }).sendAndConfirm(umi);
    console.log("Executive profile registered");
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("custom program error")) {
      console.log("Executive profile may already exist; continuing.");
    } else {
      throw err;
    }
  }

  const executiveProfilePda = findExecutiveProfileV1Pda(umi, { authority: umi.identity.publicKey });
  await delegateExecutionV1(umi, {
    agentAsset: asset.publicKey,
    agentIdentity: agentIdentityPda,
    executiveProfile: executiveProfilePda,
  }).sendAndConfirm(umi);
  console.log("Execution delegated");
  console.log("Executive profile PDA:", executiveProfilePda.toString());

  const assetSignerPda = findAssetSignerPda(umi, { asset: asset.publicKey });
  const fetched = await fetchAsset(umi, asset.publicKey);

  const result = {
    asset: asset.publicKey.toString(),
    collection: collection.publicKey.toString(),
    owner: fetched.owner.toString(),
    agentIdentityPda: agentIdentityPda.toString(),
    executiveProfilePda: executiveProfilePda.toString(),
    assetSignerPda: assetSignerPda.toString(),
    registrationUri,
  };

  console.log(JSON.stringify(result, null, 2));
  fs.writeFileSync("clawd-mint-result.json", JSON.stringify(result, null, 2));
  console.log("Wrote clawd-mint-result.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
