/**
 * Steward Sidecar — utility helpers.
 */

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
