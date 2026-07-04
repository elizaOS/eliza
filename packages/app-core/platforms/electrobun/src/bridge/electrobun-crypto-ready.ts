/** Implements Electrobun desktop electrobun crypto ready ts behavior for app-core shell integration. */
export type ElectrobunEncryptResult = {
  encryptedData: string;
  iv: string;
  tag: string;
};

export type ElectrobunEncrypt = (
  message: string,
) => Promise<ElectrobunEncryptResult>;

export type ElectrobunDecrypt = (
  encryptedData: string,
  iv: string,
  tag: string,
) => Promise<string>;

export interface ElectrobunCryptoWindow {
  __electrobunWebviewId?: number | string;
  __electrobunRpcSocketPort?: number | string;
  __electrobun_encrypt?: ElectrobunEncrypt;
  __electrobun_decrypt?: ElectrobunDecrypt;
}

declare global {
  interface Window extends ElectrobunCryptoWindow {}
}

export interface ElectrobunCryptoReadyGuardOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 10;

function hasSocketRpcGlobals(globalWindow: ElectrobunCryptoWindow): boolean {
  return Boolean(
    globalWindow.__electrobunWebviewId &&
      globalWindow.__electrobunRpcSocketPort,
  );
}

async function waitForInstalledFunction<
  Key extends "__electrobun_encrypt" | "__electrobun_decrypt",
>(
  globalWindow: ElectrobunCryptoWindow,
  key: Key,
  placeholder: NonNullable<ElectrobunCryptoWindow[Key]>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<NonNullable<ElectrobunCryptoWindow[Key]>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const candidate = globalWindow[key];
    if (typeof candidate === "function" && candidate !== placeholder) {
      return candidate as NonNullable<ElectrobunCryptoWindow[Key]>;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Electrobun preload did not install ${key} within ${timeoutMs}ms`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Electrobun injects its built-in preload before the app preload, but its
 * crypto setup resolves asynchronously. The app preload can create the
 * websocket RPC transport before `__electrobun_encrypt`/`decrypt` are assigned,
 * so early desktop RPC sends must wait for the real functions instead of
 * falling into a broken postMessage fallback.
 */
export function installElectrobunCryptoReadyGuards(
  globalWindow: ElectrobunCryptoWindow = window,
  options: ElectrobunCryptoReadyGuardOptions = {},
): boolean {
  if (!hasSocketRpcGlobals(globalWindow)) {
    return false;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let installed = false;

  if (typeof globalWindow.__electrobun_encrypt !== "function") {
    const encryptWhenReady: ElectrobunEncrypt = async (message) => {
      const encrypt = (await waitForInstalledFunction(
        globalWindow,
        "__electrobun_encrypt",
        encryptWhenReady,
        timeoutMs,
        pollIntervalMs,
      )) as ElectrobunEncrypt;
      return encrypt(message);
    };
    globalWindow.__electrobun_encrypt = encryptWhenReady;
    installed = true;
  }

  if (typeof globalWindow.__electrobun_decrypt !== "function") {
    const decryptWhenReady: ElectrobunDecrypt = async (
      encryptedData,
      iv,
      tag,
    ) => {
      const decrypt = (await waitForInstalledFunction(
        globalWindow,
        "__electrobun_decrypt",
        decryptWhenReady,
        timeoutMs,
        pollIntervalMs,
      )) as ElectrobunDecrypt;
      return decrypt(encryptedData, iv, tag);
    };
    globalWindow.__electrobun_decrypt = decryptWhenReady;
    installed = true;
  }

  return installed;
}
