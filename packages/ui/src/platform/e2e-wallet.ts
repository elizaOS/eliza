/**
 * Harness-injectable Ethereum wallet for end-to-end testing of the Eliza Cloud
 * SIWE sign-in on devices and simulators with no human in the loop (#13377).
 *
 * A test harness seeds a throwaway private key under `eliza:e2e-wallet:pk`
 * (localStorage on web; on native the key rides the storage bridge's synced
 * keys, so `defaults write <bundle> CapacitorStorage.eliza:e2e-wallet:pk …` /
 * the Android equivalent seeds it before first launch). At boot this module
 * installs a minimal EIP-1193 provider at `window.ethereum` backed by that
 * key: `eth_requestAccounts` answers without any prompt and `personal_sign`
 * signs immediately, so the normal SIWE login path (`state/cloud-siwe-login`)
 * completes a GENUINE handshake against the real cloud API untouched.
 *
 * With `eliza:e2e-wallet:autologin` = "1" the handshake runs at boot and the
 * verified session lands in the steward store before onboarding mounts — the
 * cloud-only conductor then takes its welcome-back path, which is exactly the
 * zero-interaction flow device e2e needs.
 *
 * Hard gates: never on store builds, never on deployed web origins, never over
 * a real injected wallet, and only when the harness key is present — absent all
 * four, this module is a no-op and the lazy viem import never loads.
 */
import { logger } from "@elizaos/logger";
import { isStoreBuild } from "../build-variant";
import { getBootConfig } from "../config/boot-config";
import { getInjectedEthereumProvider } from "../state/cloud-siwe-login";
import { isAndroid, isIOS } from "./init";

export const E2E_WALLET_KEY_STORAGE_KEY = "eliza:e2e-wallet:pk";
export const E2E_WALLET_AUTOLOGIN_STORAGE_KEY = "eliza:e2e-wallet:autologin";

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    // error-policy:J3 storage blocked — no harness key, no wallet
    return null;
  }
}

// The harness key rides the native storage bridge, whose Preferences
// hydration is asynchronous relative to React mount — on native, poll briefly
// so a key seeded before first launch is found regardless of boot path. Web
// harnesses control page setup (addInitScript) and get one synchronous read.
const KEY_POLL_INTERVAL_MS = 500;
const KEY_POLL_ATTEMPTS = 20;

export function isE2eWalletWebHostnameAllowed(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]"
  );
}

export function isE2eWalletInstallAllowed(): boolean {
  if (isStoreBuild()) return false;
  if (isAndroid || isIOS) return true;
  if (typeof window === "undefined") return false;
  return isE2eWalletWebHostnameAllowed(window.location.hostname);
}

async function waitForHarnessKey(): Promise<string | null> {
  const first = readStorage(E2E_WALLET_KEY_STORAGE_KEY)?.trim();
  if (first) return first;
  if (!isAndroid && !isIOS) return null;
  for (let attempt = 1; attempt < KEY_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, KEY_POLL_INTERVAL_MS));
    const key = readStorage(E2E_WALLET_KEY_STORAGE_KEY)?.trim();
    if (key) return key;
  }
  return null;
}

/**
 * Install the harness wallet when requested, then optionally run the SIWE
 * auto-login. Resolves true when a wallet was installed. Safe to call more
 * than once (idempotent per page).
 */
export async function installE2eWalletIfRequested(): Promise<boolean> {
  if (!isE2eWalletInstallAllowed()) return false;
  const rawKey = await waitForHarnessKey();
  if (!rawKey) return false;
  if (getInjectedEthereumProvider()) {
    // A real wallet (or an earlier install) already owns window.ethereum.
    return false;
  }

  const privateKey = (
    rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
  ) as `0x${string}`;
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(privateKey);

  const provider = {
    isElizaE2eWallet: true as const,
    async request(args: {
      method: string;
      params?: readonly unknown[];
    }): Promise<unknown> {
      switch (args.method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return "0x1";
        case "personal_sign": {
          const [data] = args.params ?? [];
          if (typeof data !== "string") {
            throw new Error("personal_sign requires hex message data");
          }
          return account.signMessage({
            message: { raw: data as `0x${string}` },
          });
        }
        default:
          throw new Error(
            `e2e wallet does not implement ${args.method} — extend platform/e2e-wallet.ts if a test needs it`,
          );
      }
    },
  };
  (window as { ethereum?: unknown }).ethereum = provider;
  logger.info(
    `[E2eWallet] installed harness wallet ${account.address.slice(0, 6)}…${account.address.slice(-4)}`,
  );

  if (readStorage(E2E_WALLET_AUTOLOGIN_STORAGE_KEY) === "1") {
    const { siweLoginWithInjectedWallet } = await import(
      "../state/cloud-siwe-login"
    );
    const cloudApiBase =
      getBootConfig().cloudApiBase || "https://elizacloud.ai";
    try {
      await siweLoginWithInjectedWallet(cloudApiBase);
    } catch (err) {
      // error-policy:J7 the auto-login is harness plumbing running at boot —
      // a failure must not kill app startup; the sign-in button remains the
      // visible fallback and the failure is loud in the harness logs.
      logger.error({ err }, "[E2eWallet] SIWE auto-login failed");
    }
  }
  return true;
}
