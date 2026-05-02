#!/usr/bin/env bun
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getLocalPGliteDatabaseUrl } from "../db/database-url";

const cloudRoot = path.resolve(import.meta.dir, "..", "..");
const apiDir = path.join(cloudRoot, "apps", "api");
const outputPath = path.join(apiDir, ".dev.vars");
const envExamplePath = path.join(cloudRoot, ".env.example");
const localAppUrl = process.env.ELIZA_CLOUD_LOCAL_APP_URL ?? "http://localhost:3000";
const localApiUrl = process.env.ELIZA_CLOUD_LOCAL_API_URL ?? "http://localhost:8787";

function parseEnvFile(filePath: string): Record<string, string> {
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

function generateJwtKeys(): {
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
  const publicPem = publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;

  return {
    JWT_SIGNING_PRIVATE_KEY: Buffer.from(privatePem, "utf8").toString("base64"),
    JWT_SIGNING_PUBLIC_KEY: Buffer.from(publicPem, "utf8").toString("base64"),
  };
}

function quoteDevVarValue(value: string): string {
  return JSON.stringify(value);
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;

  return (
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
    normalized.includes("123456789012") ||
    normalized.endsWith("_here") ||
    normalized.endsWith("_replace_me")
  );
}

function mergeRealEnvValues(target: Record<string, string>, source: Record<string, string>): void {
  for (const [key, value] of Object.entries(source)) {
    if (!isPlaceholderValue(value)) {
      target[key] = value;
    }
  }
}

const exampleEnv = parseEnvFile(envExamplePath);
const sourceEnvFiles = [
  parseEnvFile(path.join(cloudRoot, ".env")),
  parseEnvFile(path.join(cloudRoot, ".env.local")),
];
const env: Record<string, string> = {};

for (const sourceEnv of sourceEnvFiles) {
  mergeRealEnvValues(env, sourceEnv);
}

const knownEnvKeys = new Set([...Object.keys(exampleEnv), ...Object.keys(env)]);
for (const key of knownEnvKeys) {
  const value = process.env[key];
  if (typeof value === "string" && !isPlaceholderValue(value)) {
    env[key] = value;
  }
}

for (const key of ["CRON_SECRET", "INTERNAL_SECRET", "AGENT_TEST_BOOTSTRAP_ADMIN"]) {
  const value = process.env[key];
  if (typeof value === "string" && !isPlaceholderValue(value)) {
    env[key] = value;
  }
}

env.NODE_ENV = "development";
env.ENVIRONMENT = "local";
env.NEXT_PUBLIC_APP_URL = localAppUrl;
env.NEXT_PUBLIC_API_URL = localApiUrl;
env.ELIZA_CLOUD_URL = localAppUrl;
env.CACHE_ENABLED = env.CACHE_ENABLED || "true";
// `auto` picks Upstash REST when KV_REST_API_URL/_TOKEN are set, otherwise
// falls back to embedded Wadis (WASM Redis) for fully-offline local dev.
env.CACHE_BACKEND = env.CACHE_BACKEND || "auto";
env.REDIS_RATE_LIMITING = env.REDIS_RATE_LIMITING || "false";
env.FORCE_REDIS_EVENTS = env.FORCE_REDIS_EVENTS || "false";
// Local dev uses embedded PGlite (in-process Postgres); cloud uses Neon.
env.DATABASE_URL = env.DATABASE_URL || getLocalPGliteDatabaseUrl(process.env);
env.PAYOUT_TESTNET =
  process.env.ELIZA_CLOUD_LOCAL_ENABLE_MAINNET_PAYOUTS === "1"
    ? env.PAYOUT_TESTNET || "false"
    : "true";
env.JWT_SIGNING_KEY_ID = env.JWT_SIGNING_KEY_ID || "local-dev";

if (process.env.PLAYWRIGHT_TEST_AUTH) {
  env.PLAYWRIGHT_TEST_AUTH = process.env.PLAYWRIGHT_TEST_AUTH;
}

if (process.env.PLAYWRIGHT_TEST_AUTH_SECRET) {
  env.PLAYWRIGHT_TEST_AUTH_SECRET = process.env.PLAYWRIGHT_TEST_AUTH_SECRET;
}

if (process.env.PLAYWRIGHT_TEST_AUTH === "true") {
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    env.TEST_DATABASE_URL ||
    env.DATABASE_URL ||
    getLocalPGliteDatabaseUrl(process.env);

  env.TEST_DATABASE_URL = testDatabaseUrl;
  env.DATABASE_URL = testDatabaseUrl;
  env.CACHE_ENABLED = "false";
  env.RATE_LIMIT_DISABLED = "true";
}

if (!env.JWT_SIGNING_PRIVATE_KEY || !env.JWT_SIGNING_PUBLIC_KEY) {
  Object.assign(env, generateJwtKeys());
}

mkdirSync(apiDir, { recursive: true });

const entries = Object.entries(env)
  .filter(([key]) => /^[A-Z0-9_]+$/.test(key))
  .sort(([a], [b]) => a.localeCompare(b));

const content = [
  "# Generated by packages/scripts/sync-api-dev-vars.ts.",
  "# Local only. Do not commit.",
  "# Reads real values from .env and .env.local, drops placeholders, and generates local JWT keys when needed.",
  ...entries.map(([key, value]) => `${key}=${quoteDevVarValue(value)}`),
  "",
].join("\n");

writeFileSync(outputPath, content, "utf8");

console.log(`[sync-api-dev-vars] wrote apps/api/.dev.vars (${entries.length} keys)`);
