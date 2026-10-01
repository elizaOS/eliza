// Verifies the cloud PII scrub executor's inspection-scope fail-closed contract.
import { describe, expect, test } from "bun:test";
import { PiiScrubFabricationError } from "@elizaos/core";
import {
  createPiiScrubItemExecutor,
  PII_SCRUB_TIER0_MODEL_ID,
  type PiiScrubEscalationHandler,
  type PiiScrubExecutorInput,
} from "./pii-scrub-executor";

function input(overrides: Partial<PiiScrubExecutorInput> = {}): PiiScrubExecutorInput {
  return {
    organizationId: "00000000-0000-4000-8000-000000000001",
    jobId: "00000000-0000-4000-8000-000000000002",
    itemRef: "row-1",
    content: "Call Alice about the lab results.",
    candidateSpans: [],
    rulesetVersion: "r1",
    ...overrides,
  };
}

describe("pii scrub executor inspection scope", () => {
  test("declared candidates with nothing to judge complete on tier-0", async () => {
    const outcome = await createPiiScrubItemExecutor().scrubItem(input());
    expect(outcome).toMatchObject({
      tier0Only: true,
      modelId: PII_SCRUB_TIER0_MODEL_ID,
      inspectionScope: "declared_candidates",
    });
  });

  test("server discovery with empty candidates never yields a clean pass without a handler", async () => {
    const error = await createPiiScrubItemExecutor()
      .scrubItem(input({ inspectionScope: "server_discovery" }))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(PiiScrubFabricationError);
    expect((error as Error).message).toContain("server_discovery");
  });

  test("server discovery always runs the handler over the full content", async () => {
    const calls: Array<Parameters<PiiScrubEscalationHandler>[0]> = [];
    const escalate: PiiScrubEscalationHandler = async (params) => {
      calls.push(params);
      return { verdicts: [], modelId: "discovery-model", rulesetVersion: params.rulesetVersion };
    };
    const outcome = await createPiiScrubItemExecutor({ escalate }).scrubItem(
      input({ inspectionScope: "server_discovery" }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      text: "Call Alice about the lab results.",
      candidateSpans: [],
      inspectionScope: "server_discovery",
    });
    expect(outcome).toMatchObject({
      tier0Only: false,
      modelId: "discovery-model",
      inspectionScope: "server_discovery",
    });
  });

  test("declared residue without a handler still fails closed", async () => {
    await expect(
      createPiiScrubItemExecutor().scrubItem(input({ candidateSpans: ["Alice"] })),
    ).rejects.toBeInstanceOf(PiiScrubFabricationError);
  });
});
