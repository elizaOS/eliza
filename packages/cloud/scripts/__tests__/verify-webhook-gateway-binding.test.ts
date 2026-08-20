/**
 * Locks the messaging webhook gateway deploy contract (#18235): the pure
 * validation in verify-webhook-gateway-binding.mjs, its canonical
 * per-environment gateway origins staying byte-identical to the protected
 * Railway release workflow, and the cloud-cf-release wiring that runs the
 * check before any Worker mutation. Deterministic — no network, no wrangler.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANONICAL_WEBHOOK_GATEWAY_URLS,
  parseSecretInventoryNames,
  verifyWebhookGatewayBinding,
} from "../verify-webhook-gateway-binding.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");

function withSecret(names: string[] = []): Set<string> {
  return new Set(["ELIZA_APP_WEBHOOK_GATEWAY_SECRET", ...names]);
}

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

describe("deploy workflow contract", () => {
  const releaseWorkflow = readFileSync(
    resolve(repoRoot, ".github/workflows/cloud-cf-release.yml"),
    "utf8",
  );
  const gatewayWorkflow = readFileSync(
    resolve(repoRoot, ".github/workflows/deploy-gateway-webhook.yml"),
    "utf8",
  );

  test("canonical URLs match the protected gateway release workflow", () => {
    expect(gatewayWorkflow).toContain(
      `'${CANONICAL_WEBHOOK_GATEWAY_URLS.production}'`,
    );
    expect(gatewayWorkflow).toContain(
      `'${CANONICAL_WEBHOOK_GATEWAY_URLS.staging}'`,
    );
  });

  test("cloud-cf-release runs the binding check before Worker mutation", () => {
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
});
