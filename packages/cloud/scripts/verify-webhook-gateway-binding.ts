/** Fail-closed gateway origin, paired binding, and live secret equality check.
 * Railway remains accepted only during the staged host migration. Cloudflare
 * deployments use an authenticated nonce proof; no secret values are returned.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  CLOUDFLARE_WEBHOOK_GATEWAY_URLS,
  verifyCloudflareGatewayConfiguration,
} from "./verify-cloudflare-gateway-configuration.ts";

// Null-prototype so an environment name that collides with an Object.prototype
// member (constructor, toString, valueOf) resolves to undefined and takes the
// "no canonical gateway" branch instead of comparing against an inherited value.
export const CANONICAL_WEBHOOK_GATEWAY_URLS = Object.freeze(
  Object.assign(Object.create(null), {
    staging: "https://gateway-webhook-stg-staging.up.railway.app",
    production: "https://gateway-webhook-production.up.railway.app",
  }),
);

const PAIRED_SECRET_NAME = "ELIZA_APP_WEBHOOK_GATEWAY_SECRET";

/** Parse Wrangler's names-only secret inventory (array or {result: array}). */
export function parseSecretInventoryNames(output) {
  const parsed = JSON.parse(output);
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.result)
      ? parsed.result
      : null;
  if (entries === null) {
    throw new Error("Wrangler secret inventory was not an array");
  }
  const names = new Set();
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      entry.name.length === 0
    ) {
      throw new Error("Wrangler secret inventory contained an invalid entry");
    }
    names.add(entry.name);
  }
  return names;
}

/**
 * Validate the webhook gateway binding candidates for one deploy.
 * Returns { ok: true } or { ok: false, errors: string[] }. A blank URL is
 * valid on purpose: the unset toggle is the honest not-configured state.
 */
export function verifyWebhookGatewayBinding({
  deployEnvironment,
  gatewayUrl,
  availableSecretNames,
}) {
  const url = typeof gatewayUrl === "string" ? gatewayUrl.trim() : "";
  if (url === "") {
    return { ok: true, errors: [] };
  }

  const errors = [];
  const canonical = CANONICAL_WEBHOOK_GATEWAY_URLS[deployEnvironment];
  if (canonical === undefined) {
    errors.push(
      `DEPLOY_ENVIRONMENT "${deployEnvironment}" has no canonical webhook gateway; refusing to publish ELIZA_APP_WEBHOOK_GATEWAY_URL`,
    );
  } else if (
    url !== canonical &&
    url !== CLOUDFLARE_WEBHOOK_GATEWAY_URLS[deployEnvironment]
  ) {
    errors.push(
      // The URL is a vars. value, never a secret, so echoing the rejected
      // string is safe and turns "does not match" into a one-glance diagnosis
      // of a trailing slash, a stale host, or a cross-environment miswire.
      `ELIZA_APP_WEBHOOK_GATEWAY_URL is "${url}" but the canonical ${deployEnvironment} gateway origin is ${canonical}`,
    );
  }

  if (!availableSecretNames.has(PAIRED_SECRET_NAME)) {
    errors.push(
      `ELIZA_APP_WEBHOOK_GATEWAY_URL is configured but no existing or queued ${PAIRED_SECRET_NAME} Worker binding is present; the gateway would 401 every forwarded webhook`,
    );
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * HMAC-SHA256 of `value` keyed by a fresh random `salt`. The salt is drawn
 * per verification run (never reused, never persisted) so a digest carries
 * no meaning outside the single comparison it was generated for — even if it
 * were somehow captured, it cannot be replayed against a future run or used
 * to test guesses offline (the attacker would need the salt AND the secret).
 */
export function saltedSecretDigest(value, salt) {
  return createHmac("sha256", salt)
    .update(String(value ?? ""), "utf8")
    .digest();
}

/**
 * Value-safe proof that the Worker's queued/existing
 * ELIZA_APP_WEBHOOK_GATEWAY_SECRET and the live gateway's secret are
 * byte-identical, without either raw value or a digest of it ever being
 * logged: both sides arrive as plain in-memory strings (the same trust
 * boundary every other secret already crosses via GitHub Actions `env:` in
 * this workflow), get reduced to a one-shot salted HMAC digest, and are
 * compared with `timingSafeEqual`. Only this function's return value —
 * ok/errors naming the *binding*, never the secret — is allowed to reach a
 * log line.
 *
 * Fails closed on every non-proof path: a blank candidate (nothing to
 * verify), a blank/absent gateway value (Railway fetch failed, CLI error,
 * unreachable service, or the gateway genuinely has no secret configured),
 * or a digest mismatch are all treated as "not verified" — never a silent
 * pass. This is what actually closes the gap names-only verification left:
 * matching names with divergent values used to sail through.
 */
export function verifyWebhookGatewaySecretMatch({
  workerSecretValue,
  gatewaySecretValue,
  bindingName = PAIRED_SECRET_NAME,
}) {
  const candidate =
    typeof workerSecretValue === "string" ? workerSecretValue : "";
  if (candidate.trim() === "") {
    return {
      ok: false,
      error: `${bindingName} has no readable Worker-side value to verify against the live gateway`,
    };
  }

  const gatewayValue =
    typeof gatewaySecretValue === "string" ? gatewaySecretValue : "";
  if (gatewayValue.trim() === "") {
    return {
      ok: false,
      error: `${bindingName} could not be verified against the live gateway (its value was unreadable, unreachable, or unset); refusing to deploy rather than risk a silent 401`,
    };
  }

  const salt = randomBytes(32);
  const expected = saltedSecretDigest(candidate, salt);
  const actual = saltedSecretDigest(gatewayValue, salt);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      ok: false,
      error: `${bindingName} differs between the queued/existing Worker secret and the live gateway secret (compared by one-time salted digest; neither value nor the digest was read, logged, or written anywhere)`,
    };
  }

  return { ok: true, error: null };
}

async function main() {
  const deployEnvironment = process.env.DEPLOY_ENVIRONMENT ?? "";
  const gatewayUrl = (process.env.ELIZA_APP_WEBHOOK_GATEWAY_URL ?? "").trim();

  if (gatewayUrl.trim() === "") {
    console.log(
      "ELIZA_APP_WEBHOOK_GATEWAY_URL is not configured; webhook routes stay on the honest 503 path.",
    );
    return;
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const availableSecretNames = parseSecretInventoryNames(
    Buffer.concat(chunks).toString("utf8"),
  );
  for (const name of process.argv.slice(2)) {
    if (name.length > 0) {
      availableSecretNames.add(name);
    }
  }

  const result = verifyWebhookGatewayBinding({
    deployEnvironment,
    gatewayUrl,
    availableSecretNames,
  });
  const errors = [...result.errors];

  // Cloudflare proves selected values in place. Railway uses the existing
  // provider-side comparison until that environment completes its cutover.
  if (
    errors.length === 0 &&
    gatewayUrl === CLOUDFLARE_WEBHOOK_GATEWAY_URLS[deployEnvironment]
  ) {
    const value = process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET;
    if (!value?.trim()) throw new Error("Worker forwarder secret is missing");
    await verifyCloudflareGatewayConfiguration({
      environment: deployEnvironment,
      origin: gatewayUrl,
      bootstrapSecret: process.env.GATEWAY_WEBHOOK_BOOTSTRAP_SECRET ?? "",
      settings: { [PAIRED_SECRET_NAME]: value },
    });
  } else if (availableSecretNames.has(PAIRED_SECRET_NAME)) {
    const matchResult = verifyWebhookGatewaySecretMatch({
      workerSecretValue: process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET,
      gatewaySecretValue: process.env.WEBHOOK_GATEWAY_RAILWAY_SECRET_VALUE,
    });
    if (!matchResult.ok) {
      errors.push(matchResult.error);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`::error::${error}`);
    }
    process.exit(1);
  }
  console.log(
    `Verified the ${deployEnvironment} gateway origin, paired binding, and live secret equality; no secret value or digest was logged.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // error-policy:J1 CLI boundary: translate a failed contract into a nonzero exit for the deploy workflow.
  main().catch((error) => {
    console.error(
      `::error::webhook gateway binding verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
