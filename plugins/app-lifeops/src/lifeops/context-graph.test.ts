import { describe, expect, it, vi } from "vitest";
import {
  LifeOpsContextGraph,
  type LifeOpsContextGraphEdgeInput,
  LifeOpsContextGraphError,
  type LifeOpsContextGraphEvidenceInput,
  type LifeOpsContextGraphNodeInput,
  type LifeOpsContextGraphObservation,
  type LifeOpsContextGraphProvenanceInput,
  type LifeOpsContextGraphSourceFamily,
  mergeLifeOpsContextConfidenceScores,
} from "./context-graph.js";

const OBSERVED_AT = "2026-05-01T10:00:00.000Z";
const QUERY_NOW = "2026-05-02T10:00:00.000Z";

function provenance(
  overrides: Partial<LifeOpsContextGraphProvenanceInput> = {},
): LifeOpsContextGraphProvenanceInput {
  return {
    sourceFamily: "gmail",
    sourceId: "gmail-message-1",
    connectorId: "gmail-primary",
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<LifeOpsContextGraphEvidenceInput> = {},
): LifeOpsContextGraphEvidenceInput {
  return {
    summary: "Alice mentioned the launch plan.",
    confidence: 0.8,
    sensitivity: "personal",
    permissionScopes: ["planner"],
    provenance: provenance(),
    ...overrides,
  };
}

function node(
  stableKey: string,
  overrides: Partial<LifeOpsContextGraphNodeInput> = {},
): LifeOpsContextGraphNodeInput {
  return {
    kind: "topic",
    stableKey,
    label: stableKey,
    evidence: [
      evidence({
        provenance: provenance({ sourceId: `${stableKey}-source` }),
      }),
    ],
    ...overrides,
  };
}

function edge(
  sourceStableKey: string,
  targetStableKey: string,
  overrides: Partial<LifeOpsContextGraphEdgeInput> = {},
): LifeOpsContextGraphEdgeInput {
  return {
    kind: "relates_to",
    source: { kind: "topic", stableKey: sourceStableKey },
    target: { kind: "topic", stableKey: targetStableKey },
    evidence: [
      evidence({
        summary: `${sourceStableKey} relates to ${targetStableKey}.`,
        provenance: provenance({
          sourceId: `${sourceStableKey}-${targetStableKey}-edge`,
        }),
      }),
    ],
    ...overrides,
  };
}

function observation(
  overrides: Partial<LifeOpsContextGraphObservation>,
): LifeOpsContextGraphObservation {
  return {
    id: "obs-1",
    capturedAt: OBSERVED_AT,
    nodes: [],
    ...overrides,
  };
}

describe("LifeOpsContextGraph", () => {
  it("dedupes duplicate evidence from two connectors while retaining provenance", () => {
    const graph = new LifeOpsContextGraph();
    graph.ingestObservation(
      observation({
        id: "obs-dedupe-1",
        nodes: [
          node("launch", {
            evidence: [
              evidence({
                summary: "Launch plan says Alice owns prep.",
                confidence: 0.72,
                provenance: provenance({
                  connectorId: "gmail-primary",
                  rawContentHash: "sha256:launch-plan",
                }),
              }),
            ],
          }),
        ],
      }),
    );

    const result = graph.ingestObservation(
      observation({
        id: "obs-dedupe-2",
        nodes: [
          node("launch", {
            evidence: [
              evidence({
                summary: "Launch plan says Alice owns prep.",
                confidence: 0.91,
                provenance: provenance({
                  connectorId: "gmail-secondary",
                  rawContentHash: "sha256:launch-plan",
                }),
              }),
            ],
          }),
        ],
      }),
    );

    const stored = graph.listNodes()[0];
    expect(result).toMatchObject({
      nodesUpdated: 1,
      evidenceCreated: 0,
      evidenceMerged: 1,
    });
    expect(stored?.evidence).toHaveLength(1);
    expect(stored?.evidence[0]?.confidence).toBe(0.91);
    expect(
      stored?.evidence[0]?.provenance.map((entry) => entry.connectorId),
    ).toEqual(["gmail-primary", "gmail-secondary"]);
  });

  it("merges identity-backed person refs across source families", () => {
    const graph = new LifeOpsContextGraph();
    graph.ingestObservation(
      observation({
        id: "obs-person-gmail",
        nodes: [
          {
            kind: "person",
            label: "Alice",
            identityRefs: [{ type: "email", value: "ALICE@Example.com" }],
            evidence: [
              evidence({
                summary: "Alice sent the launch note.",
                provenance: provenance({ sourceFamily: "gmail" }),
              }),
            ],
          },
        ],
      }),
    );
    graph.ingestObservation(
      observation({
        id: "obs-person-contacts",
        nodes: [
          {
            kind: "person",
            label: "Alice A.",
            identityRefs: [
              { type: "email", value: "alice@example.com" },
              { type: "contact_id", value: "contacts/alice" },
            ],
            evidence: [
              evidence({
                summary: "Contacts identifies Alice.",
                provenance: provenance({
                  sourceFamily: "contacts",
                  sourceId: "contacts/alice",
                  connectorId: "contacts-local",
                }),
              }),
            ],
          },
        ],
      }),
    );

    const nodes = graph.listNodes();
    const byContactId = graph.getNodeByIdentity({
      type: "contact_id",
      value: "contacts/alice",
    });

    expect(nodes).toHaveLength(1);
    expect(byContactId?.id).toBe(nodes[0]?.id);
    expect(nodes[0]?.identityRefs.map((ref) => ref.normalizedValue)).toEqual([
      "alice@example.com",
      "contacts/alice",
    ]);
    expect(nodes[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("withholds sensitive evidence and records explicit reasons", async () => {
    const graph = new LifeOpsContextGraph();
    graph.ingestObservation(
      observation({
        id: "obs-sensitive",
        nodes: [
          node("travel", {
            label: "Travel",
            evidence: [
              evidence({
                summary: "Travel planning is active.",
                confidence: 0.7,
              }),
              evidence({
                summary: "SECRET_PASSPORT_NUMBER is in the drive note.",
                confidence: 0.9,
                sensitivity: "secret",
                provenance: provenance({
                  sourceFamily: "drive",
                  sourceId: "drive-secret",
                  connectorId: "drive-primary",
                  rawContentHash: "sha256:secret",
                }),
              }),
            ],
          }),
        ],
      }),
    );

    const slice = await graph.queryPlannerSlice({ now: QUERY_NOW });

    expect(slice.nodes).toHaveLength(1);
    expect(slice.nodes[0]?.withheldEvidenceCount).toBe(1);
    expect(slice.withheld).toEqual([
      expect.objectContaining({
        reason: "sensitivity_scope_restricted",
        sourceFamilies: ["drive"],
      }),
    ]);
    expect(JSON.stringify(slice)).not.toContain("SECRET_PASSPORT_NUMBER");
  });

  it("degrades stale evidence without hiding it", async () => {
    const graph = new LifeOpsContextGraph();
    graph.ingestObservation(
      observation({
        id: "obs-stale",
        nodes: [
          node("sleep", {
            evidence: [
              evidence({
                summary: "Sleep estimate came from yesterday.",
                confidence: 0.8,
                staleAfter: "2026-05-01T12:00:00.000Z",
              }),
            ],
          }),
        ],
      }),
    );

    const slice = await graph.queryPlannerSlice({ now: QUERY_NOW });

    expect(slice.nodes[0]?.confidence).toBe(0.4);
    expect(slice.nodes[0]?.degradedReasons).toContain("stale_evidence");
    expect(slice.degraded).toEqual([
      expect.objectContaining({
        reasons: ["stale_evidence"],
      }),
    ]);
  });

  it("keeps confidence in bounds and rejects invalid confidence inputs", () => {
    expect(mergeLifeOpsContextConfidenceScores([0.6, 0.8])).toBe(0.92);
    expect(mergeLifeOpsContextConfidenceScores([1, 1])).toBe(1);
    expect(() => mergeLifeOpsContextConfidenceScores([0.4, 1.2])).toThrow(
      LifeOpsContextGraphError,
    );

    const graph = new LifeOpsContextGraph();
    expect(() =>
      graph.ingestObservation(
        observation({
          id: "obs-bad-confidence",
          nodes: [
            node("bad-confidence", {
              evidence: [evidence({ confidence: -0.1 })],
            }),
          ],
        }),
      ),
    ).toThrow(LifeOpsContextGraphError);
  });

  it("dedupes repeated edges and traverses cycles without repetition", async () => {
    const graph = new LifeOpsContextGraph();
    graph.ingestObservation(
      observation({
        id: "obs-cycle",
        nodes: [node("a"), node("b")],
        edges: [edge("a", "b"), edge("a", "b"), edge("b", "a")],
      }),
    );

    const slice = await graph.queryPlannerSlice({
      focus: { kind: "topic", stableKey: "a" },
      depth: 8,
      now: QUERY_NOW,
    });

    expect(graph.listEdges()).toHaveLength(2);
    expect(slice.nodes.map((entry) => entry.label).sort()).toEqual(["a", "b"]);
    expect(slice.edges).toHaveLength(2);
  });

  it("rejects unsupported source families before graph mutation", () => {
    const graph = new LifeOpsContextGraph();
    expect(() =>
      graph.ingestObservation(
        observation({
          id: "obs-unsupported-source",
          nodes: [
            node("unsupported-source", {
              evidence: [
                evidence({
                  provenance: provenance({
                    sourceFamily: "slack" as LifeOpsContextGraphSourceFamily,
                  }),
                }),
              ],
            }),
          ],
        }),
      ),
    ).toThrow(LifeOpsContextGraphError);
    expect(graph.listNodes()).toHaveLength(0);
  });

  it("caps oversized planner queries to the configured maximum", async () => {
    const graph = new LifeOpsContextGraph({ maxQueryLimit: 2 });
    graph.ingestObservation(
      observation({
        id: "obs-limit",
        nodes: [node("one"), node("two"), node("three"), node("four")],
      }),
    );

    const slice = await graph.queryPlannerSlice({
      limit: 99,
      now: QUERY_NOW,
    });

    expect(slice.requestedLimit).toBe(99);
    expect(slice.appliedLimit).toBe(2);
    expect(slice.nodes).toHaveLength(2);
  });

  it("requires provenance on every evidence item", () => {
    const graph = new LifeOpsContextGraph();
    expect(() =>
      graph.ingestObservation(
        observation({
          id: "obs-no-provenance",
          nodes: [
            node("no-provenance", {
              evidence: [
                {
                  summary: "Missing provenance should fail closed.",
                  confidence: 0.8,
                  sensitivity: "personal",
                  permissionScopes: ["planner"],
                  provenance:
                    undefined as unknown as LifeOpsContextGraphProvenanceInput,
                },
              ],
            }),
          ],
        }),
      ),
    ).toThrow(LifeOpsContextGraphError);
  });

  it("redacts planner slices even when a policy allows the fact", async () => {
    const policyGate = vi.fn(() => ({
      allow: true as const,
      redaction: "none" as const,
    }));
    const graph = new LifeOpsContextGraph({ policyGate });
    graph.ingestObservation(
      observation({
        id: "obs-redaction",
        nodes: [
          node("mail", {
            evidence: [
              evidence({
                summary: "A private email asks for lunch.",
                quote: "Private body with home address.",
                sensitivity: "personal",
              }),
            ],
          }),
        ],
      }),
    );

    const slice = await graph.queryPlannerSlice({
      includeEvidenceQuotes: true,
      now: QUERY_NOW,
    });

    expect(policyGate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "planner_slice",
        targetType: "node",
        requiredPermissionScopes: ["planner"],
      }),
    );
    expect(slice.nodes[0]?.evidence[0]).toMatchObject({
      summary: "A private email asks for lunch.",
      redacted: true,
    });
    expect(slice.nodes[0]?.evidence[0]?.quote).toBeUndefined();
    expect(JSON.stringify(slice)).not.toContain("Private body");
  });

  it("records policy-denied evidence as withheld", async () => {
    const graph = new LifeOpsContextGraph({
      policyGate: () => ({ allow: false, reason: "policy_denied" }),
    });
    graph.ingestObservation(
      observation({
        id: "obs-policy-denied",
        nodes: [node("memory")],
      }),
    );

    const slice = await graph.queryPlannerSlice({ now: QUERY_NOW });

    expect(slice.nodes).toHaveLength(0);
    expect(slice.withheld).toEqual([
      expect.objectContaining({ reason: "policy_denied" }),
    ]);
  });
});
