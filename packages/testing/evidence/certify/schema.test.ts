/**
 * Strictness tests for the certification contract: unknown fields, unknown
 * verdict values, traversal evidence paths, waived-without-notes, duplicate
 * subjects, and short commit shas must all be rejected with typed issues.
 */

import { describe, expect, it } from "vitest";
import { EvidenceValidationError } from "../errors.ts";
import {
  type Certification,
  type CertificationPayload,
  parseCertification,
  parseCertificationPayload,
  tierSatisfies,
} from "./schema.ts";

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const SHA = "a".repeat(64);
const SIGNATURE = {
  alg: "ed25519",
  publicKeyFingerprint: "0123456789abcdef",
  value: Buffer.alloc(64, 7).toString("base64"),
} as const;

function payload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema: 1,
    bundleSha: SHA,
    commit: COMMIT,
    branch: "feat/test",
    baseRef: "develop",
    tier: "cpu",
    verdicts: [
      {
        subject: "lane:server",
        verdict: "pass",
        evidence: ["lanes/server/result.json"],
      },
    ],
    reviewer: { kind: "human", id: "shaw" },
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function certification(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...payload(), signature: { ...SIGNATURE }, ...overrides };
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceValidationError);
    return (error as EvidenceValidationError).issues.map(
      (issue) => `${issue.path}: ${issue.message}`,
    );
  }
  throw new Error("expected EvidenceValidationError");
}

describe("parseCertificationPayload", () => {
  it("accepts a well-formed payload", () => {
    const parsed: CertificationPayload = parseCertificationPayload(
      payload(),
      "test",
    );
    expect(parsed.verdicts).toHaveLength(1);
    expect(parsed.tier).toBe("cpu");
  });

  it("rejects unknown top-level fields (forward compat is a schema bump)", () => {
    const issues = issuesOf(() =>
      parseCertificationPayload(payload({ extra: true }), "test"),
    );
    expect(issues.join("\n")).toContain("extra");
  });

  it("rejects unknown verdict values", () => {
    const issues = issuesOf(() =>
      parseCertificationPayload(
        payload({
          verdicts: [{ subject: "x", verdict: "maybe", evidence: [] }],
        }),
        "test",
      ),
    );
    expect(issues.join("\n")).toContain("verdicts.0.verdict");
  });

  it("rejects absolute and traversal evidence paths", () => {
    for (const bad of ["/etc/passwd", "../secrets.txt", "a/../b", "a\\b"]) {
      const issues = issuesOf(() =>
        parseCertificationPayload(
          payload({
            verdicts: [{ subject: "x", verdict: "pass", evidence: [bad] }],
          }),
          "test",
        ),
      );
      expect(issues.join("\n")).toContain("verdicts.0.evidence.0");
    }
  });

  it("rejects waived verdicts without non-empty notes", () => {
    for (const notes of [undefined, "", "   "]) {
      const issues = issuesOf(() =>
        parseCertificationPayload(
          payload({
            verdicts: [
              { subject: "x", verdict: "waived", evidence: [], notes },
            ],
          }),
          "test",
        ),
      );
      expect(issues.join("\n")).toContain(
        "waived verdicts require non-empty notes",
      );
    }
    const ok = parseCertificationPayload(
      payload({
        verdicts: [
          {
            subject: "x",
            verdict: "waived",
            evidence: [],
            notes: "no display on cpu tier",
          },
        ],
      }),
      "test",
    );
    expect(ok.verdicts[0].verdict).toBe("waived");
  });

  it("rejects duplicate verdict subjects", () => {
    const issues = issuesOf(() =>
      parseCertificationPayload(
        payload({
          verdicts: [
            { subject: "x", verdict: "pass", evidence: [] },
            { subject: "x", verdict: "fail", evidence: [] },
          ],
        }),
        "test",
      ),
    );
    expect(issues.join("\n")).toContain("duplicate verdict subject");
  });

  it("rejects an empty verdicts array — a cert must certify something", () => {
    const issues = issuesOf(() =>
      parseCertificationPayload(payload({ verdicts: [] }), "test"),
    );
    expect(issues.join("\n")).toContain("verdicts");
  });

  it("rejects short commit shas — promotion identity must be exact", () => {
    const issues = issuesOf(() =>
      parseCertificationPayload(payload({ commit: "abcdef0" }), "test"),
    );
    expect(issues.join("\n")).toContain("40-hex");
  });

  it("rejects expiresAt at or before createdAt", () => {
    const issues = issuesOf(() =>
      parseCertificationPayload(
        payload({ expiresAt: "2026-07-04T00:00:00.000Z" }),
        "test",
      ),
    );
    expect(issues.join("\n")).toContain("expiresAt must be after createdAt");
  });
});

describe("parseCertification", () => {
  it("accepts a well-formed signed certification", () => {
    const parsed: Certification = parseCertification(certification(), "test");
    expect(parsed.signature.alg).toBe("ed25519");
  });

  it("rejects a missing signature", () => {
    const value = certification();
    delete value.signature;
    expect(() => parseCertification(value, "test")).toThrow(
      EvidenceValidationError,
    );
  });

  it("rejects signature values that are not 64-byte base64", () => {
    for (const bad of [
      "not base64!!",
      Buffer.alloc(32, 1).toString("base64"),
    ]) {
      expect(() =>
        parseCertification(
          certification({ signature: { ...SIGNATURE, value: bad } }),
          "test",
        ),
      ).toThrow(EvidenceValidationError);
    }
  });

  it("rejects unknown signature algorithms", () => {
    expect(() =>
      parseCertification(
        certification({ signature: { ...SIGNATURE, alg: "rsa" } }),
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });
});

describe("tierSatisfies", () => {
  it("orders cpu < gpu < full", () => {
    expect(tierSatisfies("full", "cpu")).toBe(true);
    expect(tierSatisfies("full", "gpu")).toBe(true);
    expect(tierSatisfies("gpu", "cpu")).toBe(true);
    expect(tierSatisfies("cpu", "cpu")).toBe(true);
    expect(tierSatisfies("cpu", "gpu")).toBe(false);
    expect(tierSatisfies("cpu", "full")).toBe(false);
    expect(tierSatisfies("gpu", "full")).toBe(false);
  });
});
