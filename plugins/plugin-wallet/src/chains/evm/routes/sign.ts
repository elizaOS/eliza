/**
 * Browser-facing EVM signing endpoints (Ethereum / Base / BSC and any other
 * viem-supported chain). Mirrors the Solana endpoint shape and shares the
 * same shared-secret bearer token gate (`WALLET_BROWSER_SIGN_TOKEN`).
 *
 * The companion JS shim assigns `window.ethereum` to an EIP-1193 provider that
 * forwards `personal_sign`, `eth_signTypedData_v4`, and `eth_sendTransaction`
 * to these endpoints. Read-only RPC calls (`eth_call`, `eth_getBalance`, etc.)
 * are forwarded by the shim straight to a public RPC for the active chain —
 * we only sign here.
 */

import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  type Address,
  type Chain,
  createWalletClient,
  type Hex,
  http,
  publicActions,
  type TypedDataDefinition,
} from "viem";
import * as viemChains from "viem/chains";
import { resolveWalletBackend } from "../../../wallet/select-backend";

type RouteHandler = NonNullable<Route["handler"]>;

interface JsonResponse {
  setHeader?: (name: string, value: string) => void;
}

function setCorsHeaders(req: RouteRequest, res: RouteResponse): void {
  const origin = (req.headers?.origin as string | undefined) ?? "*";
  const r = res as unknown as JsonResponse;
  r.setHeader?.("Access-Control-Allow-Origin", origin);
  r.setHeader?.("Vary", "Origin");
  r.setHeader?.("Access-Control-Allow-Methods", "POST, OPTIONS");
  r.setHeader?.(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Wallet-Sign-Token",
  );
  r.setHeader?.("Access-Control-Allow-Credentials", "true");
  r.setHeader?.("Access-Control-Max-Age", "600");
}

function readSignToken(runtime: IAgentRuntime): string | null {
  const fromRuntime = runtime.getSetting("WALLET_BROWSER_SIGN_TOKEN");
  if (typeof fromRuntime === "string" && fromRuntime.trim().length >= 16) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env.WALLET_BROWSER_SIGN_TOKEN?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  return null;
}

function readBearer(req: RouteRequest): string | null {
  const auth = req.headers?.authorization as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const x = req.headers?.["x-wallet-sign-token"] as string | undefined;
  if (typeof x === "string" && x.length > 0) return x.trim();
  return null;
}

function authorize(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): boolean {
  setCorsHeaders(req, res);
  if ((req as unknown as { method?: string }).method === "OPTIONS") {
    res.status(204).json({});
    return false;
  }
  const expected = readSignToken(runtime);
  if (!expected) {
    res.status(503).json({ error: "WALLET_BROWSER_SIGN_TOKEN not configured" });
    return false;
  }
  if (readBearer(req) !== expected) {
    res.status(401).json({ error: "invalid sign token" });
    return false;
  }
  return true;
}

function chainFromId(chainId: number): Chain {
  const all = Object.values(viemChains) as Chain[];
  const hit = all.find((c) => typeof c?.id === "number" && c.id === chainId);
  if (!hit) {
    throw new Error(`unsupported EVM chainId: ${chainId}`);
  }
  return hit;
}

function rpcUrlForChain(runtime: IAgentRuntime, chain: Chain): string {
  const explicit =
    (runtime.getSetting(`EVM_RPC_URL_${chain.id}`) as string | undefined) ??
    process.env[`EVM_RPC_URL_${chain.id}`] ??
    null;
  if (explicit && explicit.length > 0) return explicit;
  const def = chain.rpcUrls?.default?.http?.[0];
  if (def) return def;
  throw new Error(`no RPC URL configured for chain ${chain.id} (${chain.name})`);
}

function readChainId(body: unknown): number {
  if (typeof body !== "object" || body === null) {
    throw new Error("chainId required");
  }
  const c = (body as { chainId?: unknown }).chainId;
  if (typeof c === "number") return c;
  if (typeof c === "string") {
    const n = c.startsWith("0x") ? Number.parseInt(c.slice(2), 16) : Number(c);
    if (Number.isFinite(n)) return n;
  }
  throw new Error("chainId must be a number or hex string");
}

const addressHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const backend = await resolveWalletBackend(runtime);
    const addrs = backend.getAddresses();
    if (!addrs.evm) {
      res.status(404).json({ error: "no EVM key configured" });
      return;
    }
    res.status(200).json({ address: addrs.evm });
  } catch (err) {
    logger.error({ err }, "[wallet/evm/address] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

const personalSignHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const body = (req.body ?? {}) as { message?: unknown };
    if (typeof body.message !== "string") {
      res.status(400).json({ error: "message (hex or utf8 string) required" });
      return;
    }
    const backend = await resolveWalletBackend(runtime);
    const account = backend.getEvmAccount(1);
    const messageInput: { raw: Hex } | string = body.message.startsWith("0x")
      ? { raw: body.message as Hex }
      : body.message;
    const signature = await account.signMessage!({
      message: typeof messageInput === "string" ? messageInput : messageInput,
    });
    res.status(200).json({ signature, address: account.address });
  } catch (err) {
    logger.error({ err }, "[wallet/evm/personal-sign] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

const signTypedDataHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const body = (req.body ?? {}) as { typedData?: unknown };
    if (!body.typedData || typeof body.typedData !== "object") {
      res
        .status(400)
        .json({ error: "typedData (EIP-712 TypedDataDefinition) required" });
      return;
    }
    const backend = await resolveWalletBackend(runtime);
    const account = backend.getEvmAccount(1);
    const signature = await account.signTypedData!(
      body.typedData as TypedDataDefinition,
    );
    res.status(200).json({ signature, address: account.address });
  } catch (err) {
    logger.error({ err }, "[wallet/evm/sign-typed-data] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

interface EvmTxRequest {
  to?: Address;
  from?: Address;
  value?: Hex | string;
  data?: Hex;
  gas?: Hex | string;
  maxFeePerGas?: Hex | string;
  maxPriorityFeePerGas?: Hex | string;
  nonce?: Hex | string | number;
}

function hexOrIntToBigInt(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") {
    if (value.length === 0) return undefined;
    return value.startsWith("0x") ? BigInt(value) : BigInt(value);
  }
  return undefined;
}

const sendTransactionHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const body = (req.body ?? {}) as { tx?: EvmTxRequest };
    const chainId = readChainId(req.body);
    if (!body.tx || typeof body.tx !== "object") {
      res.status(400).json({ error: "tx (EVM transaction) required" });
      return;
    }
    const chain = chainFromId(chainId);
    const backend = await resolveWalletBackend(runtime);
    const account = backend.getEvmAccount(chainId);

    const rpcUrl = rpcUrlForChain(runtime, chain);
    const wallet = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    }).extend(publicActions);

    const tx = body.tx;
    const hash = await wallet.sendTransaction({
      account,
      chain,
      to: tx.to,
      value: hexOrIntToBigInt(tx.value),
      data: tx.data,
      gas: hexOrIntToBigInt(tx.gas),
      maxFeePerGas: hexOrIntToBigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: hexOrIntToBigInt(tx.maxPriorityFeePerGas),
      nonce:
        typeof tx.nonce === "number"
          ? tx.nonce
          : tx.nonce
            ? Number(hexOrIntToBigInt(tx.nonce))
            : undefined,
    });
    res.status(200).json({ hash, address: account.address, chainId });
  } catch (err) {
    logger.error({ err }, "[wallet/evm/send-transaction] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

const signTransactionHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const body = (req.body ?? {}) as { tx?: EvmTxRequest };
    const chainId = readChainId(req.body);
    if (!body.tx || typeof body.tx !== "object") {
      res.status(400).json({ error: "tx required" });
      return;
    }
    const chain = chainFromId(chainId);
    const backend = await resolveWalletBackend(runtime);
    const account = backend.getEvmAccount(chainId);

    const rpcUrl = rpcUrlForChain(runtime, chain);
    const wallet = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    }).extend(publicActions);

    const tx = body.tx;
    const request = await wallet.prepareTransactionRequest({
      account,
      chain,
      to: tx.to,
      value: hexOrIntToBigInt(tx.value),
      data: tx.data,
      gas: hexOrIntToBigInt(tx.gas),
      maxFeePerGas: hexOrIntToBigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: hexOrIntToBigInt(tx.maxPriorityFeePerGas),
    });
    const serialized = await wallet.signTransaction(request);
    res.status(200).json({
      signedTransaction: serialized,
      address: account.address,
      chainId,
    });
  } catch (err) {
    logger.error({ err }, "[wallet/evm/sign-transaction] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

export const evmSignRoutes: Route[] = [
  {
    type: "GET",
    path: "/wallet/evm/address",
    public: true,
    name: "wallet-evm-address",
    handler: addressHandler,
  },
  {
    type: "POST",
    path: "/wallet/evm/address",
    public: true,
    name: "wallet-evm-address-post",
    handler: addressHandler,
  },
  {
    type: "POST",
    path: "/wallet/evm/personal-sign",
    public: true,
    name: "wallet-evm-personal-sign",
    handler: personalSignHandler,
  },
  {
    type: "POST",
    path: "/wallet/evm/sign-typed-data",
    public: true,
    name: "wallet-evm-sign-typed-data",
    handler: signTypedDataHandler,
  },
  {
    type: "POST",
    path: "/wallet/evm/sign-transaction",
    public: true,
    name: "wallet-evm-sign-transaction",
    handler: signTransactionHandler,
  },
  {
    type: "POST",
    path: "/wallet/evm/send-transaction",
    public: true,
    name: "wallet-evm-send-transaction",
    handler: sendTransactionHandler,
  },
];
