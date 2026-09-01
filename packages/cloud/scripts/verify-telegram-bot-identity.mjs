#!/usr/bin/env node

/**
 * Value-safe deployment preflight for the exact Telegram bot credential.
 * Never include the token, expected identity, or provider payload in an error.
 */

import { pathToFileURL } from "node:url";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_BOT_ID = 4_503_599_627_370_495;
const DEFAULT_TIMEOUT_MS = 10_000;

class TelegramIdentityVerificationError extends Error {
  constructor(reason) {
    super("Telegram bot identity verification failed");
    this.name = "TelegramIdentityVerificationError";
    this.code = "TELEGRAM_IDENTITY_VERIFICATION_FAILED";
    this.context = { reason };
    this.reason = reason;
  }
}

function fail(reason) {
  throw new TelegramIdentityVerificationError(reason);
}

function normalizeInput(input) {
  const botToken = input.botToken?.trim() ?? "";
  const expectedBotId = input.expectedBotId?.trim() ?? "";
  const expectedBotUsername =
    input.expectedBotUsername?.trim().replace(/^@/, "") ?? "";
  const webhookSecret = input.webhookSecret?.trim() ?? "";
  if (!botToken || !expectedBotId || !expectedBotUsername || !webhookSecret) {
    fail("not_configured");
  }
  const botIdNumber = Number(expectedBotId);
  if (
    !/^[1-9]\d{0,15}$/.test(expectedBotId) ||
    !Number.isSafeInteger(botIdNumber) ||
    botIdNumber > MAX_BOT_ID ||
    !/^[A-Za-z0-9_]{5,32}$/.test(expectedBotUsername) ||
    !expectedBotUsername.toLowerCase().endsWith("bot")
  ) {
    fail("configuration_invalid");
  }
  const tokenBotId = botToken.match(/^([1-9]\d{0,15}):\S+$/)?.[1];
  if (tokenBotId !== expectedBotId) fail("identity_mismatch");
  return {
    botToken,
    expectedBotId,
    expectedBotUsernameKey: expectedBotUsername.toLowerCase(),
  };
}

export async function verifyTelegramBotIdentity(input, dependencies = {}) {
  const expected = normalizeInput(input);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response;
  try {
    response = await fetchImpl(
      `${TELEGRAM_API_BASE}/bot${expected.botToken}/getMe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    // error-policy:J1 the provider boundary discards the credential-bearing
    // transport cause and exposes only a bounded deployment failure reason.
    fail("provider_unavailable");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    // error-policy:J3 Telegram response JSON is untrusted and produces an
    // explicit bounded invalid-provider result.
    fail("provider_unavailable");
  }
  if (!response.ok || payload?.ok !== true) fail("provider_unavailable");
  const providerId =
    typeof payload.result?.id === "number" &&
    Number.isSafeInteger(payload.result.id) &&
    payload.result.id > 0
      ? String(payload.result.id)
      : "";
  const providerUsername =
    typeof payload.result?.username === "string"
      ? payload.result.username.trim().replace(/^@/, "")
      : "";
  if (
    payload.result?.is_bot !== true ||
    !providerId ||
    !/^[A-Za-z0-9_]{5,32}$/.test(providerUsername)
  ) {
    fail("provider_unavailable");
  }
  if (
    providerId !== expected.expectedBotId ||
    providerUsername.toLowerCase() !== expected.expectedBotUsernameKey
  ) {
    fail("identity_mismatch");
  }
}

function safeContext(value) {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value ?? "")
    ? value
    : "protected-environment";
}

async function main() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: protected GitHub workflows inject this standalone preflight context outside Turbo caching.
  const context = safeContext(process.env.TELEGRAM_ATTESTATION_CONTEXT);
  try {
    await verifyTelegramBotIdentity({
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: protected GitHub workflows inject this standalone preflight credential outside Turbo caching.
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: protected GitHub workflows inject this standalone preflight identity outside Turbo caching.
      expectedBotId: process.env.TELEGRAM_EXPECTED_BOT_ID,
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: protected GitHub workflows inject this standalone preflight identity outside Turbo caching.
      expectedBotUsername: process.env.TELEGRAM_EXPECTED_BOT_USERNAME,
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: protected GitHub workflows inject this standalone preflight credential outside Turbo caching.
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    });
    console.log(`Telegram identity attestation passed for ${context}.`);
  } catch (error) {
    // error-policy:J1 the CLI boundary emits only the allowlisted reason and
    // never provider payloads, expected identity values, or credentials.
    const reason =
      error instanceof TelegramIdentityVerificationError
        ? error.reason
        : "provider_unavailable";
    console.error(
      `::error::Telegram identity attestation failed for ${context} (${reason})`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
