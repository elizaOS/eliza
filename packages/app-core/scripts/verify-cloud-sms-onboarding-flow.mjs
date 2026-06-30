#!/usr/bin/env node
/**
 * Verify the deployed shared SMS onboarding flow.
 *
 * This posts synthetic inbound gateway messages to the Cloud webhook. It does
 * not send a real SMS from the local Mac, but it proves production Cloud routes
 * an unknown sender into onboarding, collects a name, emits a login link, and
 * serves the deployed continuation page.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const defaultEnvFile = path.join(
  repoRoot,
  ".eliza-local",
  "bluebubbles-bridge.env",
);
const defaultWebhookUrl =
  "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles";
const defaultGatewayPhoneNumber = "+14159611510";
const defaultGatewayPhoneLabel = `Eliza Cloud Gateway (${defaultGatewayPhoneNumber})`;
const defaultAttempts = 3;

function usage() {
  return [
    "Usage: node packages/app-core/scripts/verify-cloud-sms-onboarding-flow.mjs [options]",
    "",
    "Options:",
    "  --webhook-url <url>       Cloud gateway webhook. Defaults to production Blooio local bridge URL.",
    "  --secret <value>          Gateway secret. Defaults to BLUEBUBBLES_GATEWAY_SECRET or .eliza-local env.",
    "  --sender <phone>          Synthetic sender phone. Defaults to a random +1415555xxxx number.",
    "  --gateway-phone <phone>   Shared gateway phone. Defaults to +14159611510.",
    "  --bridge <id>             Bridge id header. Defaults to bluebubbles.",
    "  --attempts <n>            Retry attempts for transient fetch failures. Defaults to 3.",
    "  --allow-gateway-override Allow --gateway-phone to differ from +14159611510 for non-production tests.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    webhookUrl: process.env.ELIZA_CLOUD_BLUEBUBBLES_URL ?? defaultWebhookUrl,
    secret: process.env.BLUEBUBBLES_GATEWAY_SECRET,
    sender: null,
    gatewayPhone:
      process.env.BLUEBUBBLES_GATEWAY_PHONE_NUMBER ?? defaultGatewayPhoneNumber,
    bridge: process.env.BLUEBUBBLES_BRIDGE_ID ?? "bluebubbles",
    attempts: defaultAttempts,
    allowGatewayOverride: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--webhook-url") args.webhookUrl = next();
    else if (arg === "--secret") args.secret = next();
    else if (arg === "--sender") args.sender = next();
    else if (arg === "--gateway-phone") args.gatewayPhone = next();
    else if (arg === "--bridge") args.bridge = next();
    else if (arg === "--attempts") args.attempts = Number.parseInt(next(), 10);
    else if (arg === "--allow-gateway-override")
      args.allowGatewayOverride = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!args.secret) {
    const env = parseDotenvFile(defaultEnvFile);
    args.secret = env.BLUEBUBBLES_GATEWAY_SECRET;
  }
  if (!args.secret) {
    throw new Error(
      "Gateway secret is required via --secret, BLUEBUBBLES_GATEWAY_SECRET, or .eliza-local/bluebubbles-bridge.env",
    );
  }
  if (!args.sender) {
    args.sender = `+1415555${Math.floor(Math.random() * 9000 + 1000)}`;
  }
  args.gatewayPhone = normalizeNorthAmericanPhone(args.gatewayPhone);
  if (
    args.gatewayPhone !== defaultGatewayPhoneNumber &&
    !args.allowGatewayOverride
  ) {
    throw new Error(
      `Refusing to verify non-shared gateway ${args.gatewayPhone}. Expected ${defaultGatewayPhoneNumber}; pass --allow-gateway-override only for non-production tests.`,
    );
  }
  if (!Number.isInteger(args.attempts) || args.attempts <= 0) {
    throw new Error("--attempts must be a positive integer");
  }
  return args;
}

function normalizeNorthAmericanPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  const normalized =
    digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : "";
  if (!normalized) {
    throw new Error(`Invalid gateway phone number: ${value}`);
  }
  return normalized;
}

function parseDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function payloadFor({ text, guid, sender, gatewayPhone }) {
  return {
    type: "new-message",
    data: {
      guid,
      text,
      isFromMe: false,
      handle: {
        address: sender,
        service: "SMS",
      },
      chats: [
        {
          guid: `SMS;-;${sender}`,
          chatIdentifier: sender,
        },
      ],
      metadata: {
        localPhoneNumber: gatewayPhone,
        phoneNumber: gatewayPhone,
        phoneAccountId: gatewayPhone,
        phoneAccountLabel: defaultGatewayPhoneLabel,
        codexOnboardingFlowSmoke: true,
      },
    },
  };
}

async function postWebhook(args, text, suffix) {
  const guid = `cloud-sms-onboarding-${suffix}-${Date.now()}`;
  const response = await fetchWithRetry(
    args,
    args.webhookUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eliza-bridge": args.bridge,
        "x-eliza-gateway-secret": args.secret,
      },
      body: JSON.stringify(
        payloadFor({
          text,
          guid,
          sender: args.sender,
          gatewayPhone: args.gatewayPhone,
        }),
      ),
      signal: AbortSignal.timeout(30_000),
    },
    `webhook ${suffix}`,
  );
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : {};
  if (!response.ok) {
    throw new Error(`Cloud webhook failed (${response.status}): ${bodyText}`);
  }
  return body;
}

function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/[^\s)]+/);
  return match?.[0] ?? null;
}

function mentionsStarterCredit(text) {
  return /\$5\b[\s\S]{0,80}\bfree\b[\s\S]{0,80}\bcredits?\b/i.test(text);
}

function assertSmsSafeReply(label, text) {
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(text)) {
    throw new Error(
      `${label} reply included non-ASCII SMS-hostile text: ${text}`,
    );
  }
}

async function verifyContinuationUrl(url) {
  const response = await fetchWithRetry(
    { attempts: defaultAttempts },
    url,
    {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    },
    "continuation URL",
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Continuation URL failed (${response.status}): ${url}`);
  }
  if (!body.includes('id="root"') || !body.includes("/assets/index-")) {
    throw new Error(
      `Continuation URL did not return the homepage app shell: ${url}`,
    );
  }
  return {
    status: response.status,
    url: response.url,
  };
}

async function fetchWithRetry(args, url, init, label) {
  let lastError;
  const { signal: _signal, ...retryableInit } = init;
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    try {
      return await fetch(url, {
        ...retryableInit,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt < args.attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  const cause =
    lastError instanceof Error ? lastError : new Error(String(lastError));
  throw new Error(`${label} fetch failed for ${url}: ${cause.message}`, {
    cause,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const first = await postWebhook(args, "Hi Eliza", "first");
  const firstReply = String(first.replyText ?? "");
  if (first.success !== true || first.handled !== true) {
    throw new Error(`First webhook was not handled: ${JSON.stringify(first)}`);
  }
  assertSmsSafeReply("First", firstReply);
  if (!firstReply.includes("What should I call you?")) {
    throw new Error(`First reply did not ask for a name: ${firstReply}`);
  }
  if (
    !/private Eliza Cloud agents?/i.test(firstReply) ||
    !/usage-based/i.test(firstReply) ||
    !mentionsStarterCredit(firstReply)
  ) {
    throw new Error(
      `First reply did not explain product, pricing, and starter credit: ${firstReply}`,
    );
  }
  if (first.gatewayDeviceRegistered !== true) {
    throw new Error(
      `Gateway device was not registered on first webhook: ${JSON.stringify(first)}`,
    );
  }
  assertGatewayIdentity("First", first, args);

  const second = await postWebhook(args, "My name is Smoke Test", "second");
  const secondReply = String(second.replyText ?? "");
  const loginUrl = extractFirstUrl(secondReply);
  if (second.success !== true || second.handled !== true) {
    throw new Error(
      `Second webhook was not handled: ${JSON.stringify(second)}`,
    );
  }
  if (second.gatewayDeviceRegistered !== true) {
    throw new Error(
      `Gateway device was not registered on second webhook: ${JSON.stringify(second)}`,
    );
  }
  if (
    first.gatewayDeviceId &&
    second.gatewayDeviceId &&
    first.gatewayDeviceId !== second.gatewayDeviceId
  ) {
    throw new Error(
      `Gateway device registration was not stable across webhooks: first=${first.gatewayDeviceId} second=${second.gatewayDeviceId}`,
    );
  }
  assertGatewayIdentity("Second", second, args);
  assertSmsSafeReply("Second", secondReply);
  if (
    !loginUrl ||
    !loginUrl.includes("/get-started/") ||
    !loginUrl.includes("onboardingSession=")
  ) {
    throw new Error(
      `Second reply did not include a get-started onboarding link: ${secondReply}`,
    );
  }
  if (/[^\x20-\x7E]/.test(loginUrl) || loginUrl.includes("**")) {
    throw new Error(
      `Second reply included a malformed onboarding link: ${loginUrl}`,
    );
  }
  if (!mentionsStarterCredit(secondReply)) {
    throw new Error(
      `Second reply did not mention starter credit: ${secondReply}`,
    );
  }
  if (/^\s*[*_`~]+\s*$/m.test(secondReply)) {
    throw new Error(
      `Second reply included orphaned markdown punctuation: ${secondReply}`,
    );
  }

  const continuation = await verifyContinuationUrl(loginUrl);
  const stableGatewayId =
    first.gatewayDeviceId && second.gatewayDeviceId
      ? first.gatewayDeviceId
      : "unreported";
  console.log(
    `[cloud-sms-onboarding] sender=${args.sender} gateway=${args.gatewayPhone} registered=yes gatewayId=${stableGatewayId} device=${first.gatewayDevicePhoneNumber}/${first.gatewayDeviceBridgeId}/${first.gatewayDeviceProvider} first=handled second=login-link continuation=${continuation.status} ${continuation.url}`,
  );
}

function assertGatewayIdentity(label, body, args) {
  if (body.gatewayDevicePhoneNumber !== args.gatewayPhone) {
    throw new Error(
      `${label} webhook registered unexpected gateway number: ${JSON.stringify(body)}`,
    );
  }
  if (body.gatewayDeviceBridgeId !== args.bridge) {
    throw new Error(
      `${label} webhook registered unexpected gateway bridge: ${JSON.stringify(body)}`,
    );
  }
  if (body.gatewayDeviceProvider !== "blooio") {
    throw new Error(
      `${label} webhook registered unexpected gateway provider: ${JSON.stringify(body)}`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `[cloud-sms-onboarding] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
