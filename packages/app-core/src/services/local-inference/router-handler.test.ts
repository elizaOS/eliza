import { describe, expect, it } from "vitest";
import type { HandlerRegistration } from "./handler-registry";
import { filterUnavailableLocalInferenceCandidates } from "./router-handler";

function reg(provider: string, priority: number): HandlerRegistration {
  return {
    modelType: "TEXT_SMALL",
    provider,
    priority,
    registeredAt: new Date(0).toISOString(),
    handler: async () => "stub",
  };
}

describe("filterUnavailableLocalInferenceCandidates", () => {
  it("removes inactive desktop local inference from implicit routing", async () => {
    const candidates = [reg("anthropic", 0), reg("milady-local-inference", -1)];

    const filtered = filterUnavailableLocalInferenceCandidates(
      candidates,
      false,
      false,
    );

    expect(filtered.map((candidate) => candidate.provider)).toEqual([
      "anthropic",
    ]);
  });

  it("keeps desktop local inference when the user explicitly prefers it", async () => {
    const candidates = [reg("milady-local-inference", -1)];

    const filtered = filterUnavailableLocalInferenceCandidates(
      candidates,
      false,
      true,
    );

    expect(filtered).toEqual(candidates);
  });

  it("keeps desktop local inference when a model is assigned to the slot", async () => {
    const candidates = [reg("milady-local-inference", -1)];

    const filtered = filterUnavailableLocalInferenceCandidates(
      candidates,
      true,
      false,
    );

    expect(filtered).toEqual(candidates);
  });
});
