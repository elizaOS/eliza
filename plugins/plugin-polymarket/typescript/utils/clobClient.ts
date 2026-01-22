import type { IAgentRuntime } from "@elizaos/core";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID, POLYMARKET_SERVICE_NAME } from "../constants";
import type { ApiKeyCreds } from "../types";

function getPrivateKey(runtime: IAgentRuntime): `0x${string}` {
  const privateKey =
    runtime.getSetting("POLYMARKET_PRIVATE_KEY") ||
    runtime.getSetting("EVM_PRIVATE_KEY") ||
    runtime.getSetting("WALLET_PRIVATE_KEY") ||
    runtime.getSetting("PRIVATE_KEY");

  if (!privateKey) {
    throw new Error(
      "No private key found. Please set POLYMARKET_PRIVATE_KEY, EVM_PRIVATE_KEY, or WALLET_PRIVATE_KEY in your environment",
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

function normalizeSetting(value: string | number | boolean | null | undefined): string | undefined {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return undefined;
  return trimmed;
}

function parseSignatureType(
  value: string | number | boolean | null | undefined,
): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBooleanSetting(value: string | boolean | null | undefined): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

type PolymarketServiceLike = {
  ensureApiCredentials?: (options?: { allowCreate?: boolean }) => Promise<ApiKeyCreds | null>;
};

async function getPolymarketService(runtime: IAgentRuntime): Promise<PolymarketServiceLike | null> {
  const existing = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketServiceLike | null;
  if (existing) {
    return existing;
  }
  if (typeof runtime.getServiceLoadPromise !== "function") {
    return null;
  }
  try {
    // The runtime implementation accepts plugin-defined service name strings,
    // but the interface only declares ServiceTypeName. Use a type assertion.
    const loadService = runtime.getServiceLoadPromise as (
      s: string,
    ) => Promise<PolymarketServiceLike>;
    const loaded = await loadService(POLYMARKET_SERVICE_NAME);
    return loaded;
  } catch {
    return null;
  }
}

export async function initializeClobClient(runtime: IAgentRuntime): Promise<ClobClient> {
  const clobApiUrl = String(runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL);

  const privateKey = getPrivateKey(runtime);
  const signer = createClobClientSigner(privateKey);

  const signatureTypeSetting =
    runtime.getSetting("POLYMARKET_SIGNATURE_TYPE") || runtime.getSetting("CLOB_SIGNATURE_TYPE");
  const funderSetting =
    runtime.getSetting("POLYMARKET_FUNDER_ADDRESS") ||
    runtime.getSetting("POLYMARKET_FUNDER") ||
    runtime.getSetting("CLOB_FUNDER_ADDRESS");
  const signatureType = parseSignatureType(signatureTypeSetting);
  const funderAddress = normalizeSetting(funderSetting);

  const client = new ClobClient(
    clobApiUrl,
    POLYGON_CHAIN_ID,
    signer,
    undefined,
    signatureType,
    funderAddress,
  );

  return client;
}

export async function initializeClobClientWithCreds(runtime: IAgentRuntime): Promise<ClobClient> {
  const clobApiUrl = String(runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL);

  const privateKey = getPrivateKey(runtime);

  const allowCreate = parseBooleanSetting(
    normalizeSetting(runtime.getSetting("POLYMARKET_ALLOW_CREATE_API_KEY")) ?? "true",
  );

  let creds: ApiKeyCreds | null = null;
  let credsSource = "none";

  // Try to get credentials from the service first
  const service = await getPolymarketService(runtime);
  if (service?.ensureApiCredentials) {
    creds = await service.ensureApiCredentials({ allowCreate });
    if (creds) {
      credsSource = "service";
    }
  }

  // Fall back to environment variables if service didn't provide creds
  if (!creds) {
    const apiKey = normalizeSetting(runtime.getSetting("CLOB_API_KEY"));
    const apiSecret =
      normalizeSetting(runtime.getSetting("CLOB_API_SECRET")) ||
      normalizeSetting(runtime.getSetting("CLOB_SECRET"));
    const apiPassphrase =
      normalizeSetting(runtime.getSetting("CLOB_API_PASSPHRASE")) ||
      normalizeSetting(runtime.getSetting("CLOB_PASS_PHRASE"));

    if (apiKey && apiSecret && apiPassphrase) {
      creds = {
        key: apiKey,
        secret: apiSecret,
        passphrase: apiPassphrase,
      };
      credsSource = "env";
    }
  }

  if (!creds) {
    throw new Error(
      "Missing API credentials. The service failed to derive/create credentials and no " +
        "environment variables (CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE) are set. " +
        "Please ensure POLYMARKET_ALLOW_CREATE_API_KEY=true or set credentials manually.",
    );
  }

  runtime.logger?.info?.(
    `[initializeClobClientWithCreds] Using credentials from ${credsSource} (key: ${creds.key.substring(0, 8)}...)`,
  );

  const signer = createClobClientSigner(privateKey);
  const signatureTypeSetting =
    runtime.getSetting("POLYMARKET_SIGNATURE_TYPE") || runtime.getSetting("CLOB_SIGNATURE_TYPE");
  const funderSetting =
    runtime.getSetting("POLYMARKET_FUNDER_ADDRESS") ||
    runtime.getSetting("POLYMARKET_FUNDER") ||
    runtime.getSetting("CLOB_FUNDER_ADDRESS");
  const signatureType = parseSignatureType(signatureTypeSetting);
  const funderAddress = normalizeSetting(funderSetting);

  const client = new ClobClient(
    clobApiUrl,
    POLYGON_CHAIN_ID,
    signer,
    creds,
    signatureType,
    funderAddress,
  );

  return client;
}

export function getWalletAddress(runtime: IAgentRuntime): string {
  const privateKey = getPrivateKey(runtime);
  return new Wallet(privateKey).address;
}
