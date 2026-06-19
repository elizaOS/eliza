function readBoolFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const trimmed = String(raw).trim().toLowerCase();
  if (
    trimmed === "1" ||
    trimmed === "true" ||
    trimmed === "yes" ||
    trimmed === "on"
  ) {
    return true;
  }
  if (
    trimmed === "0" ||
    trimmed === "false" ||
    trimmed === "no" ||
    trimmed === "off"
  ) {
    return false;
  }
  return fallback;
}

export function isCloudWalletEnabled(): boolean {
  return readBoolFlag("ENABLE_CLOUD_WALLET");
}
