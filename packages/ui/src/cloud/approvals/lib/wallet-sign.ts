/**
 * Lightweight EIP-191 `personal_sign` helper for the in-app Approvals pane.
 *
 * This is the **wallet-signature gate** chosen for owner approvals (the
 * lower-risk, zero-backend-change path called for in the task brief): the owner
 * signs the approval challenge message with their browser wallet and the
 * resulting signature is submitted to `/approve`, exactly like the public
 * approval page — the server-side `IdentityVerificationGatekeeper` validates the
 * pasted/produced signature unchanged. We do NOT introduce a "session-trust"
 * transition because the approve endpoint requires a verifiable signature and a
 * trust-only transition would be a backend change (out of scope and higher
 * risk: it would weaken the cryptographic approval guarantee).
 *
 * Deliberately uses the injected EIP-1193 provider (`window.ethereum`) directly
 * rather than wagmi / RainbowKit so the pane stays out of the heavy wallet
 * vendor chunks. When no injected wallet is available the pane falls back to the
 * manual paste-signature flow (see {@link isInjectedWalletAvailable}).
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { ethereum?: unknown }).ethereum;
  if (
    candidate &&
    typeof (candidate as Eip1193Provider).request === "function"
  ) {
    return candidate as Eip1193Provider;
  }
  return null;
}

/** True when a browser wallet is injected and can produce a `personal_sign`. */
export function isInjectedWalletAvailable(): boolean {
  return getInjectedProvider() !== null;
}

export class WalletSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletSignError";
  }
}

/**
 * Prompt the injected wallet to `personal_sign` the given challenge message.
 * Connects the account first (`eth_requestAccounts`) if needed, then signs and
 * returns the `0x`-prefixed hex signature. Throws {@link WalletSignError} on a
 * missing wallet, a rejected request, or a non-string signature.
 */
export async function signApprovalChallenge(message: string): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new WalletSignError(
      "No browser wallet detected. Paste a signature instead.",
    );
  }

  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as unknown;
  const account =
    Array.isArray(accounts) && typeof accounts[0] === "string"
      ? accounts[0]
      : null;
  if (!account) {
    throw new WalletSignError("No wallet account is connected.");
  }

  const signature = (await provider.request({
    method: "personal_sign",
    params: [message, account],
  })) as unknown;

  if (typeof signature !== "string" || signature.length === 0) {
    throw new WalletSignError("Wallet returned an empty signature.");
  }
  return signature;
}

/** The connected wallet address, or null if none/locked. Non-throwing. */
export async function getConnectedWalletAddress(): Promise<string | null> {
  const provider = getInjectedProvider();
  if (!provider) return null;
  const accounts = (await provider
    .request({ method: "eth_accounts" })
    .catch(() => null)) as unknown;
  return Array.isArray(accounts) && typeof accounts[0] === "string"
    ? accounts[0]
    : null;
}
