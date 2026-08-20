/**
 * Sign-In With Ethereum (EIP-4361) login to Eliza Cloud through an injected
 * EIP-1193 wallet provider (`window.ethereum`).
 *
 * This is the wallet leg of the Cloud sign-in: the same genuine handshake the
 * cloud API's `/api/auth/siwe/nonce` → `/api/auth/siwe/verify` pair validates
 * server-side (nonce consumption, EIP-191 signature recovery, find-or-create
 * account) — nothing is mocked. The verified session's API key is written to
 * the canonical steward-session store, so everything downstream (connection
 * polling, agent provisioning, cloud-only onboarding's welcome-back skip)
 * treats it exactly like any other Eliza Cloud session.
 *
 * Two consumers:
 *  - a real browser wallet, driven through the normal sign-in tap; and
 *  - the e2e test wallet (`platform/e2e-wallet.ts`), which device/e2e
 *    harnesses seed with a throwaway key so onboarding can be exercised end to
 *    end on simulators and phones with zero human interaction (#13377).
 *
 * Chain binding (#18458): the SIWE message's `chainId` must match the wallet's
 * actual connected chain, not a stale default. The wallet's chain is read from
 * the EIP-1193 `eth_chainId` result, validated against the configured supported
 * login chains, passed to the nonce request so the server binds the same
 * `chainId` to the nonce, and re-read immediately before the signature so a
 * mid-prompt chain switch is detected and the handshake rebuilds or fails
 * closed — never signing a stale mainnet (1) default for a Base/BSC wallet.
 */
import { logger } from "@elizaos/logger";
import { writeStoredStewardToken } from "@elizaos/shared/steward-session-client";

/** Minimal EIP-1193 surface the login needs. */
export interface InjectedEthereumProvider {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
  /** Set by the e2e test wallet so harness-only behavior can identify it. */
  isElizaE2eWallet?: boolean;
  /** Phantom multichain-injects itself as window.ethereum; never SIWE with it. */
  isPhantom?: boolean;
}

export function getInjectedEthereumProvider(): InjectedEthereumProvider | null {
  if (typeof window === "undefined") return null;
  const provider = (window as { ethereum?: unknown }).ethereum;
  if (
    provider &&
    typeof provider === "object" &&
    typeof (provider as InjectedEthereumProvider).request === "function"
  ) {
    // Phantom injects window.ethereum (isPhantom:true) but is a Solana wallet;
    // treating it as an EVM SIWE provider pops Phantom on a non-wallet sign-in.
    // Mirrors the /login wallet-buttons guard (wallet-buttons.tsx).
    if ((provider as InjectedEthereumProvider).isPhantom === true) return null;
    return provider as InjectedEthereumProvider;
  }
  return null;
}

/**
 * The EVM chains Eliza Cloud wallet login permits. The login UI supports Base
 * (8453) and BSC (56); Ethereum mainnet (1) is deliberately NOT a supported
 * login chain here, so an absent/stale mainnet-default `chainId` fails closed
 * rather than signing authority on the wrong network.
 */
export const SUPPORTED_SIWE_LOGIN_CHAIN_IDS = Object.freeze([8453, 56]);

export function isSupportedLoginChainId(chainId: number): boolean {
  return SUPPORTED_SIWE_LOGIN_CHAIN_IDS.includes(chainId);
}

/**
 * Read the wallet's currently connected chain id via the EIP-1193
 * `eth_chainId` call. Returns the numeric chain id, or null when the provider
 * omits/rejects the call or returns a non-hex value. Per EIP-1193, `eth_chainId`
 * returns a 0x-prefixed hex string (e.g. "0x2105" for Base).
 */
export async function readWalletChainId(
  provider: InjectedEthereumProvider,
): Promise<number | null> {
  let raw: unknown;
  try {
    raw = await provider.request({ method: "eth_chainId" });
  } catch {
    // Provider rejected the call — treat the chain as unknown, fail closed.
    return null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("0x")) return null;
  const parsed = Number.parseInt(trimmed.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

interface SiweNonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  version?: string;
  statement?: string;
  chainId?: number;
}

function isNonceResponse(value: unknown): value is SiweNonceResponse {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.nonce === "string" &&
    typeof r.domain === "string" &&
    typeof r.uri === "string"
  );
}

/**
 * Compose the canonical EIP-4361 message. Built by hand (not viem's
 * `createSiweMessage`) so the login path stays free of the heavyweight viem
 * import — the server re-parses and validates every field, so there is no
 * drift risk a test wouldn't catch immediately.
 */
export function buildSiweMessage(args: {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}): string {
  const lines = [
    `${args.domain} wants you to sign in with your Ethereum account:`,
    args.address,
    "",
  ];
  if (args.statement) lines.push(args.statement, "");
  lines.push(
    `URI: ${args.uri}`,
    `Version: ${args.version}`,
    `Chain ID: ${args.chainId}`,
    `Nonce: ${args.nonce}`,
    `Issued At: ${args.issuedAt}`,
  );
  if (args.expirationTime)
    lines.push(`Expiration Time: ${args.expirationTime}`);
  return lines.join("\n");
}

function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    // error-policy:J6 diagnostics-only read of an already-failed response
    return "<unreadable body>";
  }
}

/** Bounded pre-signature nonce attempts before surfacing the failure. */
const NONCE_MAX_ATTEMPTS = 3;
/** Backoff between nonce attempts: 500ms then 1000ms (1.5s total worst case). */
const NONCE_RETRY_BASE_DELAY_MS = 500;

/**
 * Fetch the SIWE nonce with bounded retry on *transient* failures.
 *
 * The nonce leg is Redis-backed and fails CLOSED: when the cloud's nonce store
 * is briefly unreachable it returns `503 nonce_storage_unavailable` (unlike
 * rate-limiting, which fails open). A single un-retried fetch turns that
 * momentary blip into a hard, user-visible login failure — the same transient
 * class the downstream voice-session mint already retries (#16627). Mirror that
 * bounded policy here so the auth leg upstream of voice is not the weak link.
 *
 * Retryable: network/transport error (no response) and any 5xx (503 included).
 * Non-retryable: 4xx — a real, deterministic rejection the user must see now.
 * Runs entirely before any wallet signature, so retrying is side-effect free;
 * each attempt consumes a fresh server nonce.
 */
async function fetchSiweNonce(
  base: string,
  chainId: number,
): Promise<SiweNonceResponse> {
  let lastError: Error | null = null;
  const nonceUrl = `${base}/api/auth/siwe/nonce?chainId=${encodeURIComponent(
    String(chainId),
  )}`;
  for (let attempt = 1; attempt <= NONCE_MAX_ATTEMPTS; attempt += 1) {
    let nonceRes: Response;
    try {
      nonceRes = await fetch(nonceUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Transport failure (offline, DNS, TLS, aborted): transient, retry.
      lastError =
        error instanceof Error
          ? error
          : new Error(
              `Eliza Cloud SIWE nonce request failed: ${String(error)}`,
            );
      if (attempt >= NONCE_MAX_ATTEMPTS) break;
      await new Promise((resolve) =>
        setTimeout(resolve, NONCE_RETRY_BASE_DELAY_MS * attempt),
      );
      continue;
    }
    if (!nonceRes.ok) {
      const body = await readBody(nonceRes);
      const failure = new Error(
        `Eliza Cloud SIWE nonce request failed: ${nonceRes.status} ${body}`,
      );
      // Only 5xx is transient (e.g. 503 nonce_storage_unavailable). A 4xx is a
      // deterministic rejection — surface it immediately, do not retry.
      if (nonceRes.status < 500 || attempt >= NONCE_MAX_ATTEMPTS) throw failure;
      lastError = failure;
      await new Promise((resolve) =>
        setTimeout(resolve, NONCE_RETRY_BASE_DELAY_MS * attempt),
      );
      continue;
    }
    const nonce: unknown = await nonceRes.json();
    if (!isNonceResponse(nonce)) {
      throw new Error("Eliza Cloud SIWE nonce response was malformed.");
    }
    return nonce;
  }
  throw (
    lastError ?? new Error("Eliza Cloud SIWE nonce request failed: exhausted")
  );
}

/**
 * Run the SIWE handshake through the injected wallet and persist the verified
 * session. Resolves the API key on success; null when no provider is injected
 * or it exposes no account (both mean "SIWE is not available here — fall
 * through to the other sign-in paths"). Throws on a real handshake failure
 * (user rejection, server error) so the caller can surface it.
 *
 * `chainSwitchRetriesLeft` bounds the mid-prompt supported-chain-switch
 * rebuild (see the pre-sign re-read below); callers use the default.
 */
export async function siweLoginWithInjectedWallet(
  cloudApiBase: string,
  chainSwitchRetriesLeft = 1,
): Promise<string | null> {
  const provider = getInjectedEthereumProvider();
  if (!provider) return null;

  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as unknown;
  const rawAddress =
    Array.isArray(accounts) && typeof accounts[0] === "string"
      ? accounts[0]
      : null;
  if (!rawAddress) return null;
  // The server-side SIWE parser requires the EIP-55 checksummed form; real
  // wallets often return lowercase. viem is loaded lazily — sign-in is a
  // user-triggered path, the checksum helper must not ride the boot bundle.
  const { getAddress } = await import("viem");
  const address = getAddress(rawAddress);

  // Bind the SIWE message to the wallet's ACTUAL connected chain (#18458), not
  // a stale mainnet (1) default. Read eth_chainId, validate it is a supported
  // login chain, and fail closed on absent/unsupported/stale state.
  const walletChainId = await readWalletChainId(provider);
  if (walletChainId === null) {
    throw new Error(
      "Eliza Cloud SIWE login requires the wallet's connected chain, but eth_chainId was unavailable.",
    );
  }
  if (!isSupportedLoginChainId(walletChainId)) {
    throw new Error(
      `Eliza Cloud SIWE login requires a supported chain (${SUPPORTED_SIWE_LOGIN_CHAIN_IDS.join(
        ", ",
      )}), but the wallet is on chain ${walletChainId}.`,
    );
  }

  const base = cloudApiBase.replace(/\/+$/, "");
  const nonce = await fetchSiweNonce(base, walletChainId);

  // The server echoes the chainId it bound to the nonce; if it disagrees with
  // the wallet chain (e.g. an unsupported value was silently coerced), refuse
  // to sign rather than trusting the response.
  const boundChainId = nonce.chainId ?? walletChainId;
  if (boundChainId !== walletChainId) {
    throw new Error(
      `Eliza Cloud SIWE nonce bound chain ${boundChainId}, but the wallet is on chain ${walletChainId}.`,
    );
  }

  const message = buildSiweMessage({
    domain: nonce.domain,
    address,
    ...(nonce.statement ? { statement: nonce.statement } : {}),
    uri: nonce.uri,
    version: nonce.version || "1",
    chainId: walletChainId,
    nonce: nonce.nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  // Re-read the chain immediately before requesting the signature: a wallet
  // switch between the nonce fetch and the personal_sign prompt would bind the
  // signature to a different chain than the message advertises. If the chain
  // changed, rebuild the nonce+message for the new chain rather than signing a
  // stale message; if the new chain is unsupported, fail closed.
  const chainBeforeSign = await readWalletChainId(provider);
  if (chainBeforeSign === null) {
    throw new Error(
      "Eliza Cloud SIWE login could not confirm the wallet's chain before signing.",
    );
  }
  if (chainBeforeSign !== walletChainId) {
    if (!isSupportedLoginChainId(chainBeforeSign)) {
      throw new Error(
        `Eliza Cloud SIWE login: wallet switched to unsupported chain ${chainBeforeSign} before signing.`,
      );
    }
    // Chain switched to another supported login chain mid-prompt — rebuild the
    // nonce + message for the new chain so the signed authority matches it.
    // Bounded to a single rebuild: a wallet that keeps flipping chains during
    // the handshake must fail closed, not recurse indefinitely.
    if (chainSwitchRetriesLeft <= 0) {
      throw new Error(
        `Eliza Cloud SIWE login: the wallet kept switching chains during the handshake (now ${chainBeforeSign}); aborting instead of retrying.`,
      );
    }
    return siweLoginWithInjectedWallet(
      cloudApiBase,
      chainSwitchRetriesLeft - 1,
    );
  }

  const signature = (await provider.request({
    method: "personal_sign",
    params: [utf8ToHex(message), address],
  })) as unknown;
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    throw new Error("The wallet returned an invalid SIWE signature.");
  }

  const verifyRes = await fetch(`${base}/api/auth/siwe/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Eliza Cloud SIWE verify failed: ${verifyRes.status} ${await readBody(verifyRes)}`,
    );
  }
  const verified = (await verifyRes.json()) as { apiKey?: unknown };
  if (typeof verified.apiKey !== "string" || !verified.apiKey) {
    throw new Error("Eliza Cloud SIWE verify returned no API key.");
  }

  writeStoredStewardToken(verified.apiKey);
  window.dispatchEvent(new CustomEvent("steward-token-sync"));
  logger.info(
    `[CloudSiweLogin] SIWE login verified for ${address.slice(0, 6)}…${address.slice(-4)} on chain ${walletChainId}`,
  );
  return verified.apiKey;
}
