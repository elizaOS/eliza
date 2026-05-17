/**
 * Steward Sidecar - utility helpers.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:net";

/**
 * Fingerprint a high-entropy (>= 256-bit) random token using SHA-256.
 *
 * This is NOT a password hash - the steward-fi sidecar protocol stores
 * `sha256(token)` as a wire-format identifier for a randomly generated
 * token, and the comparison is timing-safe on the server. Slow KDFs are
 * unnecessary for high-entropy random tokens.
 */
export function fingerprintRandomToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function resolveDataDir(dataDir: string): string {
  if (dataDir.startsWith("~")) {
    const home =
      typeof process !== "undefined"
        ? process.env.HOME || process.env.USERPROFILE || ""
        : "";
    return dataDir.replace(/^~/, home);
  }
  return dataDir;
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `stw_${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function generateMasterPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryBindLoopbackPort(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      server.removeAllListeners();
      resolve(false);
    });

    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function allocateFirstFreeLoopbackPort(
  preferred: number,
  options: { host?: string; maxHops?: number } = {},
): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const maxHops = options.maxHops ?? 64;

  if (!Number.isFinite(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error(`Invalid preferred port: ${preferred}`);
  }

  for (let offset = 0; offset < maxHops; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65535) {
      break;
    }

    if (await tryBindLoopbackPort(candidate, host)) {
      return candidate;
    }
  }

  throw new Error(
    `No free TCP port on ${host} in range ${preferred}-${preferred + maxHops - 1}`,
  );
}
