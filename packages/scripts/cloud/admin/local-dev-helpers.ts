import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

type EnvLoadSpec = string | { path: string; override?: boolean };

export function loadEnvFiles(
  files: EnvLoadSpec[] = [".env", { path: ".env.local", override: true }],
  cwd = process.cwd(),
): void {
  for (const file of files) {
    const spec = typeof file === "string" ? { path: file } : file;
    config({
      path: path.resolve(cwd, spec.path),
      ...(spec.override === undefined ? {} : { override: spec.override }),
    });
  }
}

export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  const env: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    const rawValue = withoutExport.slice(separator + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;

    env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }

  return env;
}

export function updateEnvFile(filePath: string, key: string, value: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const replacement = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, "m");

  const content = regex.test(existing)
    ? existing.replace(regex, replacement)
    : `${existing.trimEnd()}${existing.trimEnd() ? "\n" : ""}${replacement}\n`;

  writeFileSync(filePath, content);
}

export function isPlaceholderValue(value: string | undefined): boolean {
  if (!value) return false;

  const normalized = value.trim();
  if (!normalized) return false;

  return (
    normalized === "replace_with_strong_random_secret" ||
    normalized === "your_upstash_token_here" ||
    normalized === "your_readonly_token_here" ||
    normalized === "token" ||
    normalized === "unset" ||
    /^your[-_]/i.test(normalized) ||
    /^sk-your/i.test(normalized) ||
    /^sk_test_your/i.test(normalized) ||
    /^whsec_your/i.test(normalized) ||
    /^team_your/i.test(normalized) ||
    /^prj_your/i.test(normalized) ||
    /^0xYour/i.test(normalized) ||
    /^Your[A-Z ]/i.test(normalized) ||
    /^base5[48]_encoded_/i.test(normalized) ||
    /^random_secret_/i.test(normalized) ||
    /^replace(_with|_me)?/i.test(normalized) ||
    /^0x\.\.\./i.test(normalized) ||
    normalized.includes("...") ||
    normalized.includes("example.com") ||
    normalized.includes("user:password@host") ||
    normalized.includes("your-redis.upstash.io") ||
    normalized.includes("default:token@your-redis.upstash.io") ||
    normalized.includes("123456789012") ||
    normalized.endsWith("_here") ||
    normalized.endsWith("_replace_me")
  );
}

export function generateJwtSigningKeys(): {
  JWT_SIGNING_PRIVATE_KEY: string;
  JWT_SIGNING_PUBLIC_KEY: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  const privatePem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

  return {
    JWT_SIGNING_PRIVATE_KEY: Buffer.from(privatePem, "utf8").toString("base64"),
    JWT_SIGNING_PUBLIC_KEY: Buffer.from(publicPem, "utf8").toString("base64"),
  };
}
