import "dotenv/config";
import crypto from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Connection, PublicKey } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey } from "@metaplex-foundation/umi";
import { fetchAsset, findAssetSignerPda, mplCore } from "@metaplex-foundation/mpl-core";
import {
  mplAgentIdentity,
  findAgentIdentityV1Pda,
  safeFetchAgentIdentityV1,
} from "@metaplex-foundation/mpl-agent-registry";

const CLAWD_MINT = process.env.CLAWD_MINT ?? "8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump";
const MIN_CLAWD_UI_AMOUNT = Number(process.env.MIN_CLAWD_UI_AMOUNT ?? "1");
const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function mustArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function getTokenBalanceUi(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<number> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  return accounts.value.reduce((sum, item) => {
    const amount = item.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    return sum + amount;
  }, 0);
}

function verifySignature(wallet: string, message: string, signature: string): boolean {
  const pubkey = new PublicKey(wallet);
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = bs58.decode(signature);
  return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey.toBytes());
}

function issueSession(payload: Record<string, unknown>): string {
  const secret = process.env.SESSION_SECRET ?? "dev-only-change-me";
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "CLAWD-SSO" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

async function verifyClawdSso(input: { wallet: string; agentAsset: string; message?: string; signature?: string }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const owner = new PublicKey(input.wallet);
  const mint = new PublicKey(CLAWD_MINT);

  if (input.message && input.signature && !verifySignature(input.wallet, input.message, input.signature)) {
    throw new Error("Wallet signature is invalid.");
  }

  const clawdBalance = await getTokenBalanceUi(connection, owner, mint);
  if (clawdBalance < MIN_CLAWD_UI_AMOUNT) {
    throw new Error(`Wallet holds ${clawdBalance} $CLAWD; requires ${MIN_CLAWD_UI_AMOUNT}.`);
  }

  const umi = createUmi(rpcUrl).use(mplCore()).use(mplAgentIdentity());
  const assetPk = publicKey(input.agentAsset);
  const asset = await fetchAsset(umi, assetPk);

  if (asset.owner.toString() !== owner.toString()) {
    throw new Error(`Wallet ${owner.toString()} is not the owner of agent asset ${input.agentAsset}.`);
  }

  const identityPda = findAgentIdentityV1Pda(umi, { asset: assetPk });
  const identity = await safeFetchAgentIdentityV1(umi, identityPda);
  if (!identity) throw new Error("Agent asset is not registered in the Metaplex Agent Registry.");

  const assetSignerPda = findAssetSignerPda(umi, { asset: assetPk });

  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(process.env.SESSION_TTL_SECONDS ?? "3600");
  const tier = clawdBalance >= 10000 ? "executive" : clawdBalance >= 1000 ? "operator" : "holder";
  const sessionPayload = {
    iss: "https://x402.wtf",
    aud: ["https://x402.wtf", "https://clawdrouter.fly.dev"],
    scheme: "CLAWD_AUTH_V1",
    wallet: owner.toString(),
    agentAsset: input.agentAsset,
    clawdMint: CLAWD_MINT,
    clawdBalance,
    tier,
    agentIdentityPda: identityPda.toString(),
    assetSignerPda: assetSignerPda.toString(),
    iat: now,
    exp: now + ttl,
  };

  return {
    ok: true,
    session: issueSession(sessionPayload),
    claims: sessionPayload,
  };
}

async function main() {
  const wallet = mustArg("wallet");
  const agentAsset = mustArg("agentAsset");
  const message = arg("message");
  const signature = arg("signature");
  const result = await verifyClawdSso({ wallet, agentAsset, message, signature });
  console.log(JSON.stringify(result, null, 2));
}

const isCli = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isCli) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err?.message ?? err) }, null, 2));
    process.exit(1);
  });
}

export { verifyClawdSso };
