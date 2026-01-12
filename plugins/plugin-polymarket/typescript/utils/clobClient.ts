import type { IAgentRuntime } from "@elizaos/core";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID } from "../constants";
import type { ApiKeyCreds } from "../types";

function getPrivateKey(runtime: IAgentRuntime): `0x${string}` {
  const privateKey =
    runtime.getSetting("POLYMARKET_PRIVATE_KEY") ||
    runtime.getSetting("EVM_PRIVATE_KEY") ||
    runtime.getSetting("WALLET_PRIVATE_KEY") ||
    runtime.getSetting("PRIVATE_KEY");

  if (!privateKey) {
    throw new Error(
      "No private key found. Please set POLYMARKET_PRIVATE_KEY, EVM_PRIVATE_KEY, or WALLET_PRIVATE_KEY in your environment"
    );
  }

  const keyStr = String(privateKey);
  const key = keyStr.startsWith("0x") ? keyStr : `0x${keyStr}`;
  return key as `0x${string}`;
}

type ClobClientSigner = ConstructorParameters<typeof ClobClient>[2];

function createClobClientSigner(privateKey: `0x${string}`): ClobClientSigner {
  return new Wallet(privateKey);
}

export async function initializeClobClient(runtime: IAgentRuntime): Promise<ClobClient> {
  const clobApiUrl = String(runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL);

  const privateKey = getPrivateKey(runtime);
  const signer = createClobClientSigner(privateKey);

  const client = new ClobClient(clobApiUrl, POLYGON_CHAIN_ID, signer, undefined);

  return client;
}

export async function initializeClobClientWithCreds(runtime: IAgentRuntime): Promise<ClobClient> {
  const clobApiUrl = String(runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL);

  const privateKey = getPrivateKey(runtime);

  const apiKey = runtime.getSetting("CLOB_API_KEY");
  const apiSecret = runtime.getSetting("CLOB_API_SECRET") || runtime.getSetting("CLOB_SECRET");
  const apiPassphrase =
    runtime.getSetting("CLOB_API_PASSPHRASE") || runtime.getSetting("CLOB_PASS_PHRASE");

  if (!apiKey || !apiSecret || !apiPassphrase) {
    const missing: string[] = [];
    if (!apiKey) missing.push("CLOB_API_KEY");
    if (!apiSecret) missing.push("CLOB_API_SECRET or CLOB_SECRET");
    if (!apiPassphrase) missing.push("CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE");
    throw new Error(
      `Missing required API credentials: ${missing.join(", ")}. Please set these environment variables first.`
    );
  }

  const signer = createClobClientSigner(privateKey);

  const creds: ApiKeyCreds = {
    key: String(apiKey),
    secret: String(apiSecret),
    passphrase: String(apiPassphrase),
  };

  const client = new ClobClient(clobApiUrl, POLYGON_CHAIN_ID, signer, creds);

  return client;
}

export function getWalletAddress(runtime: IAgentRuntime): string {
  const privateKey = getPrivateKey(runtime);
  return new Wallet(privateKey).address;
}
