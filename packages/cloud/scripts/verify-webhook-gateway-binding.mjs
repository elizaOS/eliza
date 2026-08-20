/**
 * Fail-closed deploy contract for the Worker's messaging webhook gateway
 * binding. cloud-cf-release publishes ELIZA_APP_WEBHOOK_GATEWAY_URL as a
 * routing toggle: absent means webhook routes 503 honestly
 * (WEBHOOK_GATEWAY_NOT_CONFIGURED, #18235), but a configured URL silently
 * accepts two miswires this check refuses before any Worker mutation —
 * pointing one environment's Worker at the other environment's gateway, and
 * configuring the URL without the paired ELIZA_APP_WEBHOOK_GATEWAY_SECRET
 * (the gateway's enforceForwarderSecret then 401s every forwarded webhook,
 * which is strictly worse than the honest 503).
 *
 * The canonical per-environment gateway origins are the same values
 * .github/workflows/deploy-gateway-webhook.yml pins as EXPECTED_GATEWAY_URL;
 * the deploy-contract test keeps the two in sync. The CLI mirrors the other
 * candidate verifiers in cloud-cf-release: a names-only `wrangler secret list`
 * inventory arrives on stdin, this deploy's queued binding names as argv, and
 * DEPLOY_ENVIRONMENT / ELIZA_APP_WEBHOOK_GATEWAY_URL from the environment.
 * Secret values are never read or printed.
 */

import { pathToFileURL } from "node:url";

export const CANONICAL_WEBHOOK_GATEWAY_URLS = Object.freeze({
  staging: "https://gateway-webhook-stg-staging.up.railway.app",
  production: "https://gateway-webhook-production.up.railway.app",
});

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
      `ELIZA_APP_WEBHOOK_GATEWAY_URL does not match the canonical ${deployEnvironment} gateway origin ${canonical}`,
    );
  }

  if (!availableSecretNames.has(PAIRED_SECRET_NAME)) {
    errors.push(
      `ELIZA_APP_WEBHOOK_GATEWAY_URL is configured but no existing or queued ${PAIRED_SECRET_NAME} Worker binding is present; the gateway would 401 every forwarded webhook`,
    );
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
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
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`::error::${error}`);
    }
    process.exit(1);
  }
  console.log(
    `Verified the ${deployEnvironment} webhook gateway URL against the canonical origin and its paired forwarder secret binding name; secret values were not read.`,
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
