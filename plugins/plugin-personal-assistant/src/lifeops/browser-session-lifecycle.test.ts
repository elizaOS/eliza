import { describe, expect, it } from "vitest";
import { summarizeBrowserTaskLifecycle } from "./browser-session-lifecycle";

function sessionWithInterventions(
  interventions: Array<Record<string, unknown>>,
) {
  return {
    actions: [],
    status: "running",
    metadata: {},
    result: {
      browserTask: {
        lastUpdatedAt: "2026-08-25T12:00:00.000Z",
        interventions,
      },
    },
  };
}

describe("browser task intervention normalization", () => {
  it("drops resolvedAt on an intervention that is not resolved", () => {
    const summary = summarizeBrowserTaskLifecycle(
      sessionWithInterventions([
        {
          kind: "confirm",
          status: "requested",
          requestedAt: "2026-08-25T00:00:00.000Z",
          resolvedAt: "2026-08-25T00:05:00.000Z",
        },
      ]),
    );
    expect(summary.interventions).toHaveLength(1);
    const intervention = summary.interventions[0];
    expect(intervention.status).toBe("requested");
    expect(intervention.resolvedAt).toBeNull();
  });

  it("keeps resolvedAt for resolved interventions", () => {
    const summary = summarizeBrowserTaskLifecycle(
      sessionWithInterventions([
        {
          kind: "confirm",
          status: "resolved",
          requestedAt: "2026-08-25T00:00:00.000Z",
          resolvedAt: "2026-08-25T00:05:00.000Z",
        },
      ]),
    );
    expect(summary.interventions[0].resolvedAt).toBe(
      "2026-08-25T00:05:00.000Z",
    );
  });

  it("defaults resolvedAt to the patch timestamp for resolved interventions missing it", () => {
    const summary = summarizeBrowserTaskLifecycle(
      sessionWithInterventions([
        {
          kind: "confirm",
          status: "resolved",
          requestedAt: "2026-08-25T00:00:00.000Z",
        },
      ]),
    );
    expect(summary.interventions[0].resolvedAt).toBe(
      "2026-08-25T12:00:00.000Z",
    );
  });

  it("surfaces a pending intervention as needsHuman with its reason as blockedReason", () => {
    const summary = summarizeBrowserTaskLifecycle(
      sessionWithInterventions([
        {
          kind: "approval",
          status: "requested",
          reason: "owner confirmation required",
          requestedAt: "2026-08-25T00:00:00.000Z",
        },
      ]),
    );
    expect(summary.needsHuman).toBe(true);
    expect(summary.blockedReason).toBe("owner confirmation required");
  });
});
