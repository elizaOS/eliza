/**
 * Locks the messaging webhook gateway deploy contract (#18235): the pure
 * validation in verify-webhook-gateway-binding.mjs, its canonical
 * per-environment gateway origins staying byte-identical to the protected
 * Railway release workflow, and the cloud-cf-release wiring that runs the
 * check before the atomic Worker secrets version is written. Deterministic —
 * no network, no wrangler.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANONICAL_WEBHOOK_GATEWAY_URLS,
  parseSecretInventoryNames,
  saltedSecretDigest,
  verifyWebhookGatewayBinding,
  verifyWebhookGatewaySecretMatch,
} from "../verify-webhook-gateway-binding.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");

function withSecret(names: string[] = []): Set<string> {
  return new Set(["ELIZA_APP_WEBHOOK_GATEWAY_SECRET", ...names]);
}

// Built from concatenated, unremarkable fragments (never a literal
// secret-shaped string) so this fixture can never trip gitleaks' full-history
// scan, which flags high-entropy/prefixed strings regardless of intent.
const FIXTURE_WORKER_SECRET = [
  "fixture",
  "forwarder",
  "value",
  "alpha",
  "7",
].join("-");
const FIXTURE_GATEWAY_SECRET_MATCHING = FIXTURE_WORKER_SECRET;
const FIXTURE_GATEWAY_SECRET_ROTATED = [
  "fixture",
  "forwarder",
  "value",
  "beta",
  "9",
].join("-");

describe("verifyWebhookGatewayBinding", () => {
  test("blank or whitespace URL is the honest not-configured state", () => {
    for (const gatewayUrl of ["", "   ", undefined]) {
      expect(
        verifyWebhookGatewayBinding({
          deployEnvironment: "staging",
          gatewayUrl,
          availableSecretNames: new Set(),
        }),
      ).toEqual({ ok: true, errors: [] });
    }
  });

  test("accepts the canonical staging URL with the paired secret", () => {
    expect(
      verifyWebhookGatewayBinding({
        deployEnvironment: "staging",
        gatewayUrl: CANONICAL_WEBHOOK_GATEWAY_URLS.staging,
        availableSecretNames: withSecret(),
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  test("accepts the canonical production URL with the paired secret", () => {
    expect(
      verifyWebhookGatewayBinding({
        deployEnvironment: "production",
        gatewayUrl: CANONICAL_WEBHOOK_GATEWAY_URLS.production,
        availableSecretNames: withSecret(),
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  test("rejects a cross-environment miswire (prod gateway on staging)", () => {
    const result = verifyWebhookGatewayBinding({
      deployEnvironment: "staging",
      gatewayUrl: CANONICAL_WEBHOOK_GATEWAY_URLS.production,
      availableSecretNames: withSecret(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(
      CANONICAL_WEBHOOK_GATEWAY_URLS.staging,
    );
  });

  test("rejects a configured URL without the paired forwarder secret", () => {
    const result = verifyWebhookGatewayBinding({
      deployEnvironment: "staging",
      gatewayUrl: CANONICAL_WEBHOOK_GATEWAY_URLS.staging,
      availableSecretNames: new Set(["DATABASE_URL"]),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(
      "ELIZA_APP_WEBHOOK_GATEWAY_SECRET",
    );
  });

  test("a queued (not yet published) secret name satisfies the pairing", () => {
    expect(
      verifyWebhookGatewayBinding({
        deployEnvironment: "production",
        gatewayUrl: CANONICAL_WEBHOOK_GATEWAY_URLS.production,
        availableSecretNames: withSecret(["OPENAI_API_KEY"]),
      }).ok,
    ).toBe(true);
  });

  test("rejects an environment with no canonical gateway", () => {
    const result = verifyWebhookGatewayBinding({
      deployEnvironment: "preview",
      gatewayUrl: CANONICAL_WEBHOOK_GATEWAY_URLS.staging,
      availableSecretNames: withSecret(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("preview");
  });

  test("an Object.prototype member name is not a canonical environment", () => {
    for (const deployEnvironment of ["constructor", "toString", "valueOf"]) {
      const result = verifyWebhookGatewayBinding({
        deployEnvironment,
        gatewayUrl: CANONICAL_WEBHOOK_GATEWAY_URLS.staging,
        availableSecretNames: withSecret(),
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain(
        "has no canonical webhook gateway",
      );
    }
  });

  test("the mismatch error echoes the rejected URL for operator diagnosis", () => {
    const result = verifyWebhookGatewayBinding({
      deployEnvironment: "staging",
      gatewayUrl: `${CANONICAL_WEBHOOK_GATEWAY_URLS.staging}/`,
      availableSecretNames: withSecret(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(
      `"${CANONICAL_WEBHOOK_GATEWAY_URLS.staging}/"`,
    );
  });

  test("collects both failures at once", () => {
    const result = verifyWebhookGatewayBinding({
      deployEnvironment: "staging",
      gatewayUrl: "https://gateway-webhook-attacker.example.com",
      availableSecretNames: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

describe("parseSecretInventoryNames", () => {
  test("parses a bare array and a {result} wrapper", () => {
    const entries = JSON.stringify([{ name: "A" }, { name: "B" }]);
    expect(parseSecretInventoryNames(entries)).toEqual(new Set(["A", "B"]));
    expect(
      parseSecretInventoryNames(JSON.stringify({ result: [{ name: "C" }] })),
    ).toEqual(new Set(["C"]));
  });

  test("rejects malformed inventories instead of returning empty", () => {
    expect(() => parseSecretInventoryNames('{"foo":1}')).toThrow(
      "not an array",
    );
    expect(() => parseSecretInventoryNames('[{"name":""}]')).toThrow(
      "invalid entry",
    );
    expect(() => parseSecretInventoryNames("[null]")).toThrow("invalid entry");
  });
});

describe("saltedSecretDigest", () => {
  test("the same value under the same salt digests identically", () => {
    const salt = Buffer.from("fixture-salt-one");
    expect(saltedSecretDigest(FIXTURE_WORKER_SECRET, salt)).toEqual(
      saltedSecretDigest(FIXTURE_WORKER_SECRET, salt),
    );
  });

  test("different values under the same salt digest differently", () => {
    const salt = Buffer.from("fixture-salt-one");
    expect(saltedSecretDigest(FIXTURE_WORKER_SECRET, salt)).not.toEqual(
      saltedSecretDigest(FIXTURE_GATEWAY_SECRET_ROTATED, salt),
    );
  });

  test("the same value under different salts digests differently", () => {
    expect(
      saltedSecretDigest(FIXTURE_WORKER_SECRET, Buffer.from("salt-a")),
    ).not.toEqual(
      saltedSecretDigest(FIXTURE_WORKER_SECRET, Buffer.from("salt-b")),
    );
  });

  test("the digest never contains the source value as a substring", () => {
    const digest = saltedSecretDigest(
      FIXTURE_WORKER_SECRET,
      Buffer.from("fixture-salt-one"),
    ).toString("hex");
    expect(digest).not.toContain(FIXTURE_WORKER_SECRET);
  });
});

describe("verifyWebhookGatewaySecretMatch", () => {
  test("matching Worker and gateway values pass", () => {
    const result = verifyWebhookGatewaySecretMatch({
      workerSecretValue: FIXTURE_WORKER_SECRET,
      gatewaySecretValue: FIXTURE_GATEWAY_SECRET_MATCHING,
    });
    expect(result).toEqual({ ok: true, error: null });
  });

  test("a mismatched gateway value fails and names the binding, not the value", () => {
    const result = verifyWebhookGatewaySecretMatch({
      workerSecretValue: FIXTURE_WORKER_SECRET,
      gatewaySecretValue: FIXTURE_GATEWAY_SECRET_ROTATED,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ELIZA_APP_WEBHOOK_GATEWAY_SECRET");
    expect(result.error).not.toContain(FIXTURE_WORKER_SECRET);
    expect(result.error).not.toContain(FIXTURE_GATEWAY_SECRET_ROTATED);
  });

  test("an unreachable/erroring proof source (blank gateway value) fails closed", () => {
    for (const gatewaySecretValue of ["", "   ", undefined]) {
      const result = verifyWebhookGatewaySecretMatch({
        workerSecretValue: FIXTURE_WORKER_SECRET,
        gatewaySecretValue,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("unreadable, unreachable, or unset");
    }
  });

  test("a missing Worker-side candidate fails closed rather than skipping", () => {
    for (const workerSecretValue of ["", "   ", undefined]) {
      const result = verifyWebhookGatewaySecretMatch({
        workerSecretValue,
        gatewaySecretValue: FIXTURE_GATEWAY_SECRET_MATCHING,
      });
      expect(result.ok).toBe(false);
    }
  });

  test("no fixture or error output contains a plaintext secret-shaped literal", () => {
    const outputs = [
      verifyWebhookGatewaySecretMatch({
        workerSecretValue: FIXTURE_WORKER_SECRET,
        gatewaySecretValue: FIXTURE_GATEWAY_SECRET_ROTATED,
      }).error,
      verifyWebhookGatewaySecretMatch({
        workerSecretValue: FIXTURE_WORKER_SECRET,
        gatewaySecretValue: undefined,
      }).error,
    ];
    for (const output of outputs) {
      expect(output).not.toContain(FIXTURE_WORKER_SECRET);
      expect(output).not.toContain(FIXTURE_GATEWAY_SECRET_MATCHING);
      expect(output).not.toContain(FIXTURE_GATEWAY_SECRET_ROTATED);
    }
  });
});

describe("deploy workflow contract", () => {
  const releaseWorkflow = readFileSync(
    resolve(repoRoot, ".github/workflows/cloud-cf-release.yml"),
    "utf8",
  );
  const gatewayWorkflow = readFileSync(
    resolve(repoRoot, ".github/workflows/deploy-gateway-webhook.yml"),
    "utf8",
  );

  // Asserting the whole ternary, not each URL independently: both strings are
  // always present in that workflow, so a transposed environment-to-URL
  // mapping — the exact miswire this PR exists to refuse — would slip past a
  // presence-only assertion.
  const mappingExpression = (production: string, staging: string) =>
    `inputs.environment == 'production' && '${production}' || '${staging}'`;

  test("canonical URLs match the protected gateway release workflow mapping", () => {
    expect(gatewayWorkflow).toContain(
      mappingExpression(
        CANONICAL_WEBHOOK_GATEWAY_URLS.production,
        CANONICAL_WEBHOOK_GATEWAY_URLS.staging,
      ),
    );
  });

  test("a transposed environment-to-URL mapping would fail the sync assertion", () => {
    expect(gatewayWorkflow).not.toContain(
      mappingExpression(
        CANONICAL_WEBHOOK_GATEWAY_URLS.staging,
        CANONICAL_WEBHOOK_GATEWAY_URLS.production,
      ),
    );
  });

  test("cloud-cf-release runs the binding check before the atomic secrets file", () => {
    expect(releaseWorkflow).toContain(
      "verify_webhook_gateway_binding_candidates() {",
    );
    expect(releaseWorkflow).toContain("verify-webhook-gateway-binding.mjs");
    const call = releaseWorkflow.indexOf(
      "verify_webhook_gateway_binding_candidates || exit 1",
    );
    const secretsFile = releaseWorkflow.indexOf("worker-secrets-file.mjs");
    expect(call).toBeGreaterThan(-1);
    expect(secretsFile).toBeGreaterThan(call);
  });

  // The value-match half (#18235 follow-up): a names-only inventory alone
  // cannot prove the Worker's queued secret still matches the live gateway's,
  // so the binding check must also fetch a live Railway value and hand it to
  // the node script before that same call site.
  test("cloud-cf-release fetches the live gateway secret from Railway before verifying", () => {
    const fetchCall = releaseWorkflow.indexOf("railway variable list");
    const railwayInstall = releaseWorkflow.indexOf(
      "Install pinned Railway CLI for webhook gateway value match",
    );
    const bindingCheckDef = releaseWorkflow.indexOf(
      "verify_webhook_gateway_binding_candidates() {",
    );
    const nodeInvocation = releaseWorkflow.indexOf(
      "WEBHOOK_GATEWAY_RAILWAY_SECRET_VALUE=$railway_gateway_secret_value",
    );
    expect(railwayInstall).toBeGreaterThan(-1);
    expect(fetchCall).toBeGreaterThan(bindingCheckDef);
    expect(nodeInvocation).toBeGreaterThan(fetchCall);
  });

  test("cloud-cf-release wires the RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK scope used by the deploy-gateway-webhook value-match precedent", () => {
    expect(releaseWorkflow).toContain(
      "RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK: ${{ vars.RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK }}",
    );
    expect(gatewayWorkflow).toContain("RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK");
  });

  test("the fetched Railway value is only ever passed as an env assignment, never echoed", () => {
    const occurrences = releaseWorkflow
      .split("\n")
      .filter((line) => line.includes("railway_gateway_secret_value"));
    for (const line of occurrences) {
      expect(line).not.toMatch(/^\s*echo\b.*railway_gateway_secret_value/);
      expect(line).not.toMatch(/::error::.*\$railway_gateway_secret_value/);
      expect(line).not.toMatch(/::notice::.*\$railway_gateway_secret_value/);
    }
    expect(occurrences.length).toBeGreaterThan(0);
  });
});
