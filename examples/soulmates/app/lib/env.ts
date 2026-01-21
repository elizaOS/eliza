export function readEnv(key: string): string | null {
  const value = process.env[key]?.trim();
  return value || null;
}

export function readCsvEnv(key: string): string[] {
  const value = readEnv(key);
  if (!value) return [];
  return value
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

export function readBooleanEnv(key: string, fallback = false): boolean {
  return readEnv(key) === "true" || (!readEnv(key) && fallback);
}

export function readNumberEnv(key: string, fallback: number): number {
  const value = readEnv(key);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isDevLoginEnabled(): boolean {
  return readBooleanEnv(
    "DEV_LOGIN_ENABLED",
    process.env.NODE_ENV === "development",
  );
}
