/**
 * Fail-closed deploy contract for the Worker's messaging webhook gateway
 * binding. cloud-cf-release publishes ELIZA_APP_WEBHOOK_GATEWAY_URL as a
 * routing toggle: absent means webhook routes 503 honestly
 * (WEBHOOK_GATEWAY_NOT_CONFIGURED, #18235), but a configured URL silently
 * accepts three miswires this check refuses before the atomic Worker secrets
 * version is written — pointing one environment's Worker at the other
 * environment's gateway, configuring the URL without the paired
 * ELIZA_APP_WEBHOOK_GATEWAY_SECRET binding name, and queuing a Worker secret
 * whose VALUE no longer matches the live gateway's (a stale or half-rotated
 * secret — the gateway's enforceForwarderSecret then 401s every forwarded
 * webhook, which is strictly worse than the honest 503).
 *
 * The canonical per-environment gateway origins are the same values
 * .github/workflows/deploy-gateway-webhook.yml pins as EXPECTED_GATEWAY_URL;
 * the deploy-contract test keeps the two in sync. The CLI mirrors the other
 * candidate verifiers in cloud-cf-release: a names-only `wrangler secret list`
 * inventory arrives on stdin, this deploy's queued binding names as argv, and
 * DEPLOY_ENVIRONMENT / ELIZA_APP_WEBHOOK_GATEWAY_URL from the environment.
 * Secret values are never read or printed by the names-only half of the check.
 *
 * The value half (`verifyWebhookGatewaySecretMatch`) closes the "same name,
 * different value" gap left by names-only verification. It mirrors the
 * salted-HMAC-digest pattern deploy-gateway-webhook.yml already uses to
 * cross-check the protected staging Blooio secrets between the Worker's
 * GitHub Environment and the live Railway variable: the calling workflow
 * fetches the live gateway secret from Railway (the same trusted source that
 * pattern already reads) and hands both candidate values to this process over
 * env vars exactly like every other secret already flowing through this
 * workflow. Neither raw value, nor any digest of it, is ever written to
 * stdout/stderr/the job log/an artifact — only a pass/fail verdict and the
 * binding *name* are. A fresh random salt is drawn per invocation so a
 * digest can never be replayed or compared outside this one process. Any
 * failure to obtain the live gateway value (unreachable Railway API, CLI
 * error, blank variable) is treated as a mismatch — fail closed, never a
 * silent pass — per the repo's error-policy doctrine (root CLAUDE.md
 * "Error-Handling Simplification"). Full live-gateway validation still
 * depends on network reachability to the deployed Railway service; that half
 * of the proof cannot run in an offline unit test, only the pure comparison
 * logic can (and does, below).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

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
  } else if (url !== canonical) {
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
  const gatewayUrl = process.env.ELIZA_APP_WEBHOOK_GATEWAY_URL ?? "";

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

  // The value-match half only runs once the names-only half already found a
  // binding to check; it reads its inputs from env vars the calling workflow
  // sets immediately before this invocation (the Worker candidate from the
  // same GitHub Environment secret every other queue_secret call already
  // uses, the gateway candidate from a Railway fetch it just performed) and
  // never persists or forwards either value beyond this process.
  if (availableSecretNames.has(PAIRED_SECRET_NAME)) {
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
    `Verified the ${deployEnvironment} webhook gateway URL against the canonical origin, its paired forwarder secret binding name, and (by one-time salted digest) that the Worker and live gateway secret values match; no secret value or digest was read, logged, or written.`,
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
