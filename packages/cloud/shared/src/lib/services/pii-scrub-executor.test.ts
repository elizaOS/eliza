/**
 * Contract tests for the CLOUD-lane per-item scrub executor (#14808).
 *
 * Drives the REAL tier-0 detectors (`detectPii` from @elizaos/core — the same
 * deterministic floor the LOCAL lane runs) and the seam's REAL fail-closed
 * validator (`assertValidScrubResult`). No mock stands in for the thing under
 * test; the only injected piece is the escalation handler, which IS the
 * executor's designed plug point for the server compute lanes.
 */

import { describe, expect, test } from "bun:test";
import { PiiScrubFabricationError, type PiiScrubResult } from "@elizaos/core";
import {
  createPiiScrubItemExecutor,
  PII_SCRUB_TIER0_MODEL_ID,
  type PiiScrubEscalationHandler,
} from "./pii-scrub-executor";

const RULESET = "2026.07";

function input(
  overrides: Partial<
    Parameters<ReturnType<typeof createPiiScrubItemExecutor>["scrubItem"]>[0]
  > = {},
) {
  return {
    organizationId: "00000000-0000-4000-8000-000000000001",
    jobId: "00000000-0000-4000-8000-000000000002",
    itemRef: "item-1",
    content: "Contact me at jane.doe@example.com about the invoice.",
    candidateSpans: [] as readonly string[],
    rulesetVersion: RULESET,
    ...overrides,
  };
}

describe("createPiiScrubItemExecutor — deterministic tier-0 floor", () => {
  test("no candidate spans → tier-0 completes with ZERO model calls", async () => {
    let escalations = 0;
    const executor = createPiiScrubItemExecutor({
      escalate: async () => {
        escalations++;
        throw new Error("must not be called");
      },
    });

    const outcome = await executor.scrubItem(input());

    expect(outcome.tier0Only).toBe(true);
    expect(outcome.modelId).toBe(PII_SCRUB_TIER0_MODEL_ID);
    // The real detectors DID run: the email is a tier-0 span.
    expect(outcome.tier0SpanCount).toBeGreaterThanOrEqual(1);
    expect(outcome.escalatedSpanCount).toBe(0);
    expect(escalations).toBe(0);
  });

  test("candidates fully covered by tier-0 spans never escalate", async () => {
    let escalations = 0;
    const executor = createPiiScrubItemExecutor({
      escalate: async () => {
        escalations++;
        throw new Error("must not be called");
      },
    });

    const outcome = await executor.scrubItem(
      // Both the exact tier-0 span and a substring of it are covered.
      input({ candidateSpans: ["jane.doe@example.com", "jane.doe"] }),
    );

    expect(outcome.tier0Only).toBe(true);
    expect(escalations).toBe(0);
  });
});

describe("createPiiScrubItemExecutor — throw-never-fabricate", () => {
  test("residue with NO escalation handler fails closed (never passes un-inspected)", async () => {
    const executor = createPiiScrubItemExecutor();
    await expect(
      executor.scrubItem(input({ candidateSpans: ["Jane Doe of Acme Corp"] })),
    ).rejects.toThrow(PiiScrubFabricationError);
  });

  test("a fabricated result (pii verdict without replacement) is rejected", async () => {
    const executor = createPiiScrubItemExecutor({
      escalate: async () => ({
        verdicts: [{ span: "Jane Doe", kind: "pii" }],
        modelId: "fake-model",
        rulesetVersion: RULESET,
      }),
    });
    await expect(
      executor.scrubItem(
        input({
          content: "Jane Doe met the auditor.",
          candidateSpans: ["Jane Doe"],
        }),
      ),
    ).rejects.toThrow(PiiScrubFabricationError);
  });

  test("a stale-ruleset verdict is rejected", async () => {
    const executor = createPiiScrubItemExecutor({
      escalate: async () => ({
        verdicts: [{ span: "Jane Doe", kind: "safe" }],
        modelId: "fake-model",
        rulesetVersion: "some-older-version",
      }),
    });
    await expect(
      executor.scrubItem(
        input({
          content: "Jane Doe met the auditor.",
          candidateSpans: ["Jane Doe"],
        }),
      ),
    ).rejects.toThrow(PiiScrubFabricationError);
  });

  test("a silently-dropped candidate is rejected (no verdict = no pass)", async () => {
    const executor = createPiiScrubItemExecutor({
      escalate: async () => ({
        verdicts: [],
        modelId: "fake-model",
        rulesetVersion: RULESET,
      }),
    });
    await expect(
      executor.scrubItem(
        input({
          content: "Jane Doe met the auditor.",
          candidateSpans: ["Jane Doe"],
        }),
      ),
    ).rejects.toThrow(PiiScrubFabricationError);
  });

  test("an escalation handler failure propagates — never defaulted to clean", async () => {
    const executor = createPiiScrubItemExecutor({
      escalate: async () => {
        throw new Error("upstream model unavailable");
      },
    });
    await expect(
      executor.scrubItem(
        input({
          content: "Jane Doe met the auditor.",
          candidateSpans: ["Jane Doe"],
        }),
      ),
    ).rejects.toThrow("upstream model unavailable");
  });
});

describe("createPiiScrubItemExecutor — escalation of residue", () => {
  test("only tier-0-uncovered residue reaches the handler; valid verdicts complete", async () => {
    const seen: Array<readonly string[]> = [];
    const escalate: PiiScrubEscalationHandler = async (params) => {
      seen.push(params.candidateSpans);
      const result: PiiScrubResult = {
        verdicts: params.candidateSpans.map((span) => ({
          span,
          kind: "pii" as const,
          replacement: "[REDACTED]",
        })),
        modelId: "cerebras/test-model",
        rulesetVersion: params.rulesetVersion,
      };
      return result;
    };
    const executor = createPiiScrubItemExecutor({ escalate });

    const outcome = await executor.scrubItem(
      input({
        content: "Jane Doe (jane.doe@example.com) met the auditor.",
        candidateSpans: ["jane.doe@example.com", "Jane Doe"],
      }),
    );

    expect(outcome.tier0Only).toBe(false);
    expect(outcome.modelId).toBe("cerebras/test-model");
    expect(outcome.escalatedSpanCount).toBe(1);
    // The email was covered by tier-0; only the name residue escalated.
    expect(seen).toEqual([["Jane Doe"]]);
  });
});
