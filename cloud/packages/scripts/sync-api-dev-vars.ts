#!/usr/bin/env bun
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getLocalPGliteDatabaseUrl } from "../db/database-url";
import { generateJwtSigningKeys, isPlaceholderValue, parseEnvFile } from "./local-dev-helpers";

const cloudRoot = path.resolve(import.meta.dir, "..", "..");
const apiDir = path.join(cloudRoot, "apps", "api");
const outputPath = path.join(apiDir, ".dev.vars");
const envExamplePath = path.join(cloudRoot, ".env.example");
const localAppUrl = process.env.ELIZA_CLOUD_LOCAL_APP_URL ?? "http://localhost:3000";
const localApiUrl = process.env.ELIZA_CLOUD_LOCAL_API_URL ?? "http://localhost:8787";

function quoteDevVarValue(value: string): string {
  return JSON.stringify(value);
}

function mergeRealEnvValues(target: Record<string, string>, source: Record<string, string>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isRealValue(value)) {
      target[key] = value;
    }
  }
}

function isRealValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !isPlaceholderValue(value);
}

function ensureLocalSharedSecret(key: string): void {
  if (isRealValue(env[key])) return;
  if (isRealValue(process.env[key])) {
    env[key] = process.env[key];
    return;
  }
  if (isRealValue(existingDevVars[key])) {
    env[key] = existingDevVars[key];
    return;
  }

  env[key] = crypto.randomBytes(32).toString("hex");
}

function mirrorEnvValue(targetKey: string, sourceKeys: string[]): void {
  if (isRealValue(env[targetKey])) return;

  for (const sourceKey of sourceKeys) {
    if (isRealValue(env[sourceKey])) {
      env[targetKey] = env[sourceKey];
      return;
    }
  }
}

function mirrorDerivedValue(targetKey: string, derive: () => string | undefined): void {
  if (isRealValue(env[targetKey])) return;
  const value = derive();
  if (isRealValue(value)) {
    env[targetKey] = value;
  }
}

function joinUrl(baseUrl: string | undefined, pathname: string): string | undefined {
  if (!isRealValue(baseUrl)) return undefined;
  try {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const exampleEnv = parseEnvFile(envExamplePath);
const existingDevVars = parseEnvFile(outputPath);
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
  if (isRealValue(value)) {
    env[key] = value;
  }
}

for (const key of [
  "CRON_SECRET",
  "INTERNAL_SECRET",
  "GATEWAY_INTERNAL_SECRET",
  "AGENT_SERVER_SHARED_SECRET",
  "AGENT_TEST_BOOTSTRAP_ADMIN",
  "PAYOUT_STATUS_SKIP_LIVE_BALANCE",
]) {
  const value = process.env[key];
  if (isRealValue(value)) {
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

for (const key of [
  "INTERNAL_SECRET",
  "GATEWAY_INTERNAL_SECRET",
  "AGENT_SERVER_SHARED_SECRET",
  "ELIZA_API_TOKEN",
]) {
  ensureLocalSharedSecret(key);
}

mirrorEnvValue("ELIZAOS_CLOUD_API_KEY", ["ELIZA_CLOUD_API_KEY"]);
mirrorEnvValue("ELIZA_CLOUD_API_KEY", ["ELIZAOS_CLOUD_API_KEY"]);
mirrorEnvValue("STEWARD_JWT_SECRET", ["STEWARD_SESSION_SECRET"]);
mirrorEnvValue("STEWARD_API_KEY", ["STEWARD_TENANT_API_KEY"]);
mirrorEnvValue("DISCORD_API_TOKEN", ["DISCORD_BOT_TOKEN"]);
mirrorEnvValue("DISCORD_APPLICATION_ID", ["DISCORD_CLIENT_ID"]);
mirrorEnvValue("DISCORD_TEST_CHANNEL_ID", ["DISCORD_CHANNEL_ID"]);
mirrorEnvValue("TELEGRAM_BOT_TOKEN", ["ELIZA_APP_TELEGRAM_BOT_TOKEN"]);
mirrorEnvValue("TELEGRAM_WEBHOOK_SECRET", ["ELIZA_APP_TELEGRAM_WEBHOOK_SECRET"]);
mirrorEnvValue("WHATSAPP_ACCESS_TOKEN", ["ELIZA_APP_WHATSAPP_ACCESS_TOKEN"]);
mirrorEnvValue("WHATSAPP_TOKEN", ["WHATSAPP_ACCESS_TOKEN", "ELIZA_APP_WHATSAPP_ACCESS_TOKEN"]);
mirrorEnvValue("WHATSAPP_PHONE_NUMBER_ID", ["ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID"]);
mirrorEnvValue("WHATSAPP_APP_SECRET", ["ELIZA_APP_WHATSAPP_APP_SECRET"]);
mirrorEnvValue("WHATSAPP_VERIFY_TOKEN", ["ELIZA_APP_WHATSAPP_VERIFY_TOKEN"]);
mirrorEnvValue("WHATSAPP_BUSINESS_PHONE", ["ELIZA_APP_WHATSAPP_PHONE_NUMBER"]);
mirrorEnvValue("WHATSAPP_PHONE_NUMBER", ["ELIZA_APP_WHATSAPP_PHONE_NUMBER"]);
mirrorEnvValue("BLOOIO_API_KEY", ["ELIZA_APP_BLOOIO_API_KEY"]);
mirrorEnvValue("BLOOIO_WEBHOOK_SECRET", ["ELIZA_APP_BLOOIO_WEBHOOK_SECRET"]);
mirrorEnvValue("BLOOIO_FROM_NUMBER", ["ELIZA_APP_BLOOIO_PHONE_NUMBER"]);
mirrorEnvValue("TWILIO_ACCOUNT_SID", ["ELIZA_APP_TWILIO_ACCOUNT_SID"]);
mirrorEnvValue("TWILIO_AUTH_TOKEN", ["ELIZA_APP_TWILIO_AUTH_TOKEN"]);
mirrorEnvValue("TWILIO_PHONE_NUMBER", ["ELIZA_APP_TWILIO_PHONE_NUMBER"]);
mirrorEnvValue("FAL_API_KEY", ["FAL_KEY"]);
mirrorEnvValue("GOOGLE_GENERATIVE_AI_API_KEY", ["GOOGLE_API_KEY"]);
mirrorEnvValue("GOOGLE_API_KEY", ["GOOGLE_GENERATIVE_AI_API_KEY"]);
mirrorEnvValue("UPSTASH_REDIS_REST_URL", ["KV_REST_API_URL"]);
mirrorEnvValue("UPSTASH_REDIS_REST_TOKEN", ["KV_REST_API_TOKEN"]);
mirrorEnvValue("X_BEARER_TOKEN", ["TWITTER_BEARER_TOKEN"]);
mirrorEnvValue("GITHUB_TOKEN", ["GIT_ACCESS_TOKEN"]);
mirrorEnvValue("LINEAR_OAUTH_CLIENT_ID", ["LINEAR_CLIENT_ID"]);
mirrorEnvValue("LINEAR_OAUTH_CLIENT_SECRET", ["LINEAR_CLIENT_SECRET"]);
mirrorDerivedValue("GOOGLE_REDIRECT_URI", () =>
  joinUrl(env.NEXT_PUBLIC_API_URL, "/api/connectors/google/oauth/callback"),
);

if (process.env.PLAYWRIGHT_TEST_AUTH) {
  env.PLAYWRIGHT_TEST_AUTH = process.env.PLAYWRIGHT_TEST_AUTH;
}

if (isRealValue(process.env.PLAYWRIGHT_TEST_AUTH_SECRET)) {
  env.PLAYWRIGHT_TEST_AUTH_SECRET = process.env.PLAYWRIGHT_TEST_AUTH_SECRET;
}

if (process.env.PLAYWRIGHT_TEST_AUTH === "true") {
  ensureLocalSharedSecret("PLAYWRIGHT_TEST_AUTH_SECRET");

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
  Object.assign(env, generateJwtSigningKeys());
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
