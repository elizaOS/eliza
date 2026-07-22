/** Verifies content hashes/counts from canonical messages without retaining text. */

import { describe, expect, it } from "vitest";
import {
  buildGatewayContentAttestation,
  parseGatewayContentContract,
} from "../src/index.js";

const CONTRACT = {
  schema_version: 1,
  contract_id: "lifecycle_test_v1",
  system_hint: "shared reviewed hint",
  public_user_turns: ["current public request", "previous public request"],
  forbidden_text_by_category: {
    scenario_ids: ["hidden_scenario_id"],
    scoring_behavior_labels: ["spawn_subagent"],
  },
  observed_text_by_category: {
    workspace_paths: ["/reviewed/workspace"],
  },
};

describe("gateway content attestation", () => {
  it("counts exact message-content occurrences and emits no raw text", () => {
    const contract = parseGatewayContentContract(CONTRACT);
    const proof = buildGatewayContentAttestation(contract, [
      { role: "system", content: "prefix shared reviewed hint suffix" },
      { role: "user", content: "previous public request" },
      { role: "assistant", content: "status" },
      {
        role: "user",
        content: "current public request in /reviewed/workspace",
      },
    ]);

    expect(proof.systemHintInstructionOccurrences).toBe(1);
    expect(proof.systemHintUserOccurrences).toBe(0);
    expect(Object.values(proof.publicUserMatches).sort()).toEqual([1, 1]);
    expect(proof.forbiddenIngressMatchCounts).toEqual({
      scenario_ids: 0,
      scoring_behavior_labels: 0,
    });
    expect(proof.forbiddenIngressMatchTotal).toBe(0);
    expect(proof.observedIngressMatchCounts).toEqual({ workspace_paths: 1 });
    expect(proof.observedInstructionMatchCounts).toEqual({ workspace_paths: 0 });
    expect(proof.observedUserMatchCounts).toEqual({ workspace_paths: 1 });
    expect(proof.messageContentManifest).toHaveLength(4);
    const serialized = JSON.stringify(proof);
    for (const text of [
      "shared reviewed hint",
      "current public request",
      "previous public request",
      "/reviewed/workspace",
    ]) {
      expect(serialized).not.toContain(text);
    }
  });

  it("exposes forbidden matches while keeping the audit content-free", () => {
    const proof = buildGatewayContentAttestation(
      parseGatewayContentContract(CONTRACT),
      [
        {
          role: "user",
          content: "current public request hidden_scenario_id spawn_subagent",
        },
      ],
    );

    expect(proof.forbiddenIngressMatchCounts).toEqual({
      scenario_ids: 1,
      scoring_behavior_labels: 1,
    });
    expect(proof.forbiddenIngressMatchTotal).toBe(2);
    expect(JSON.stringify(proof)).not.toContain("hidden_scenario_id");
  });

  it("does not certify a user turn from an assistant echo", () => {
    const contract = parseGatewayContentContract(CONTRACT);
    const proof = buildGatewayContentAttestation(contract, [
      { role: "system", content: "shared reviewed hint" },
      { role: "user", content: "a different request" },
      { role: "assistant", content: "current public request" },
    ]);

    expect(proof.publicUserMatches).toEqual({});
    expect(Object.values(proof.publicUserGeneratedMatches)).toEqual([1]);
  });

  it("separates generated forbidden text from ingress leakage", () => {
    const contract = parseGatewayContentContract(CONTRACT);
    const generated = buildGatewayContentAttestation(contract, [
      { role: "system", content: "shared reviewed hint" },
      { role: "user", content: "current public request" },
      { role: "assistant", content: "spawn_subagent" },
    ]);
    const leaked = buildGatewayContentAttestation(contract, [
      { role: "system", content: "shared reviewed hint spawn_subagent" },
      { role: "user", content: "current public request" },
    ]);

    expect(generated.forbiddenIngressMatchTotal).toBe(0);
    expect(generated.forbiddenGeneratedMatchTotal).toBe(1);
    expect(leaked.forbiddenIngressMatchTotal).toBe(1);
  });

  it("rejects duplicate public turns and malformed categories", () => {
    expect(() =>
      parseGatewayContentContract({
        ...CONTRACT,
        public_user_turns: ["same", "same"],
      }),
    ).toThrow("may not contain duplicates");
    expect(() =>
      parseGatewayContentContract({
        ...CONTRACT,
        forbidden_text_by_category: { "unsafe category": ["value"] },
      }),
    ).toThrow("category is invalid");
  });
});
