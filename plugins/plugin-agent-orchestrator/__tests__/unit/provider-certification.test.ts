/**
 * Exercises the deterministic provider-certification matrix against real
 * disposable filesystem tasks while provider transports remain fixture-bound.
 * Live-provider success is deliberately outside this CI test.
 */
import { describe, expect, it } from "vitest";
import {
  CERTIFICATION_SURFACE_NAMES,
  findCertificationSecretLeaks,
  PROVIDER_CERTIFICATION_ROUTES,
  runDeterministicProviderCertification,
  sanitizeCertificationSurfaces,
} from "../../src/services/provider-certification.js";

describe("provider certification matrix", () => {
  it("covers every requested provider route with explicit billing truth", () => {
    const ids = PROVIDER_CERTIFICATION_ROUTES.map((route) => route.id);
    expect(ids).toEqual([
      "kimi-cli-subscription",
      "kimi-coding-plan-inference",
      "zai-coding-plan",
      "zai-api",
      "deepseek-consumer-subscription",
      "deepseek-api",
      "openai-codex-subscription",
      "openai-api",
      "claude-subscription",
      "anthropic-api",
      "grok-build-subscription",
      "xai-api",
      "openrouter-api",
    ]);
    expect(
      PROVIDER_CERTIFICATION_ROUTES.find(
        (route) => route.id === "openrouter-api",
      )?.billingMode,
    ).toBe("api-credits-or-byok");
    expect(
      PROVIDER_CERTIFICATION_ROUTES.find(
        (route) => route.id === "kimi-cli-subscription",
      )?.billingMode,
    ).toBe("subscription-allowance-or-opt-in-extra-usage");
    expect(
      PROVIDER_CERTIFICATION_ROUTES.find(
        (route) => route.id === "zai-coding-plan",
      ),
    ).toMatchObject({
      supported: true,
      backend: "opencode",
      authMode: "coding-plan-key",
      billingMode: "subscription-coding-plan",
      credentialEnvironmentKey: "ZAI_API_KEY",
    });
  });

  it("runs read/edit/test proofs and emits one receipt for every supported route", () => {
    const report = runDeterministicProviderCertification();
    expect(report.mode).toBe("deterministic");
    expect(report.receipts).toHaveLength(PROVIDER_CERTIFICATION_ROUTES.length);
    for (const receipt of report.receipts) {
      const route = PROVIDER_CERTIFICATION_ROUTES.find(
        (candidate) => candidate.id === receipt.routeId,
      );
      expect(route).toBeDefined();
      if (route?.supported) {
        expect(receipt).toMatchObject({
          status: "PASS",
          task: {
            read: true,
            edit: true,
            test: true,
            successfulReceiptCount: 1,
          },
          redaction: {
            surfacesScanned: CERTIFICATION_SURFACE_NAMES,
            secretLeakCount: 0,
          },
        });
        expect(receipt.artifactSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(receipt.task.receiptId).toMatch(/^[0-9a-f]{64}$/u);
        expect(receipt.billing.source).toBe(`fixture:${route.billingMode}`);
        if (route.id === "zai-coding-plan") {
          expect(receipt.account.authMode).toBe("coding-plan-key");
          expect(receipt.billing.mode).toBe("subscription-coding-plan");
        }
      } else {
        expect(receipt.status).toBe("UNAVAILABLE");
        expect(receipt.billing.source).toBeNull();
        expect(receipt.reason).toMatch(/\S/u);
        expect(route?.documentationUrl).toMatch(/^https:\/\//u);
      }
    }
  });

  it("proves failure handling without duplicate task receipts", () => {
    const report = runDeterministicProviderCertification();
    const expectedFailures = [
      "revoked",
      "expired",
      "exhausted",
      "rate-limited",
    ];
    for (const route of PROVIDER_CERTIFICATION_ROUTES.filter(
      (candidate) => candidate.supported,
    )) {
      const proofs = report.failoverProofs.filter(
        (proof) => proof.routeId === route.id,
      );
      expect(proofs.map((proof) => proof.failure)).toEqual(expectedFailures);
      for (const proof of proofs) {
        expect(proof.duplicateTask).toBe(false);
        expect(
          proof.attempts.every((attempt) =>
            attempt.accountRef.startsWith(route.providerId),
          ),
        ).toBe(true);
        if (route.failoverPolicy === "same-provider") {
          expect(proof.verdict).toBe("failover-pass");
          expect(proof.successfulReceiptCount).toBe(1);
          expect(proof.attempts).toHaveLength(2);
        } else {
          expect(proof.verdict).toBe("fail-closed-pass");
          expect(proof.successfulReceiptCount).toBe(0);
          expect(proof.attempts).toHaveLength(1);
        }
      }
    }
  });
});

describe("certification evidence redaction", () => {
  it("removes sentinel secrets from every persisted surface", () => {
    const sentinel = "sentinel-provider-secret-0123456789";
    const surfaces = Object.fromEntries(
      CERTIFICATION_SURFACE_NAMES.map((name) => [
        name,
        { name, secret: sentinel },
      ]),
    ) as Record<(typeof CERTIFICATION_SURFACE_NAMES)[number], unknown>;
    expect(findCertificationSecretLeaks(surfaces, [sentinel])).toHaveLength(
      CERTIFICATION_SURFACE_NAMES.length,
    );
    const sanitized = sanitizeCertificationSurfaces(surfaces, {
      providerCredential: sentinel,
    });
    expect(findCertificationSecretLeaks(sanitized, [sentinel])).toEqual([]);
    for (const name of CERTIFICATION_SURFACE_NAMES) {
      expect(JSON.stringify(sanitized[name])).toContain("REDACTED");
    }
  });
});
