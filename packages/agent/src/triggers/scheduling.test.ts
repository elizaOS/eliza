import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildTriggerConfig,
  buildTriggerDedupeKey,
  normalizeTriggerDraft,
} from "./scheduling.js";

const FALLBACK = {
  displayName: "fallback",
  instructions: "fallback instructions",
  triggerType: "interval" as const,
  wakeMode: "inject_now" as const,
  enabled: true,
  createdBy: "api",
};

describe("normalizeTriggerDraft — workflow kind", () => {
  it("synthesizes instructions from workflowName when none are provided", () => {
    const result = normalizeTriggerDraft({
      input: {
        displayName: "Nightly Sync",
        triggerType: "interval",
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "api",
        intervalMs: 60_000,
        kind: "workflow",
        workflowId: "wf-42",
        workflowName: "Nightly Sync Workflow",
      },
      fallback: {
        ...FALLBACK,
        // Fallback instructions empty on purpose so we exercise synthesis.
        instructions: "",
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.draft?.instructions).toBe(
      "Run workflow Nightly Sync Workflow",
    );
    expect(result.draft?.kind).toBe("workflow");
    expect(result.draft?.workflowId).toBe("wf-42");
    expect(result.draft?.workflowName).toBe("Nightly Sync Workflow");
  });

  it("synthesizes instructions from workflowId when workflowName is missing", () => {
    const result = normalizeTriggerDraft({
      input: {
        displayName: "Nightly Sync",
        triggerType: "interval",
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "api",
        intervalMs: 60_000,
        kind: "workflow",
        workflowId: "wf-42",
      },
      fallback: { ...FALLBACK, instructions: "" },
    });

    expect(result.error).toBeUndefined();
    expect(result.draft?.instructions).toBe("Run workflow wf-42");
  });

  it("rejects workflow kind with missing workflowId", () => {
    const result = normalizeTriggerDraft({
      input: {
        displayName: "Nightly Sync",
        triggerType: "interval",
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "api",
        intervalMs: 60_000,
        kind: "workflow",
        workflowId: undefined,
      },
      fallback: FALLBACK,
    });

    expect(result.draft).toBeUndefined();
    expect(result.error).toBe("workflowId is required for workflow triggers");
  });

  it("leaves text-kind normalization unchanged (back-compat)", () => {
    const result = normalizeTriggerDraft({
      input: {
        displayName: "Reminder",
        instructions: "say hi",
        triggerType: "interval",
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "api",
        intervalMs: 60_000,
      },
      fallback: FALLBACK,
    });

    expect(result.error).toBeUndefined();
    expect(result.draft?.instructions).toBe("say hi");
    expect(result.draft?.kind).toBeUndefined();
    expect(result.draft?.workflowId).toBeUndefined();
  });
});

describe("buildTriggerConfig — workflow propagation", () => {
  it("propagates kind / workflowId / workflowName onto TriggerConfig", () => {
    const triggerId = "00000000-0000-0000-0000-000000000001" as UUID;
    const config = buildTriggerConfig({
      triggerId,
      draft: {
        displayName: "Nightly Sync",
        instructions: "Run workflow wf-42",
        triggerType: "interval",
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "api",
        intervalMs: 60_000,
        kind: "workflow",
        workflowId: "wf-42",
        workflowName: "Nightly Sync Workflow",
      },
    });

    expect(config.kind).toBe("workflow");
    expect(config.workflowId).toBe("wf-42");
    expect(config.workflowName).toBe("Nightly Sync Workflow");
  });
});

describe("buildTriggerDedupeKey — workflow discrimination", () => {
  it("produces different keys for text vs workflow kind with the same instructions", () => {
    const base = {
      triggerType: "interval" as const,
      instructions: "run job",
      intervalMs: 60_000,
      wakeMode: "inject_now" as const,
    };
    const textKey = buildTriggerDedupeKey(base);
    const workflowKey = buildTriggerDedupeKey({
      ...base,
      kind: "workflow",
      workflowId: "wf-42",
    });
    expect(textKey).not.toBe(workflowKey);
  });

  it("produces different keys for different workflowIds", () => {
    const base = {
      triggerType: "interval" as const,
      instructions: "run job",
      intervalMs: 60_000,
      wakeMode: "inject_now" as const,
      kind: "workflow" as const,
    };
    const key1 = buildTriggerDedupeKey({ ...base, workflowId: "wf-1" });
    const key2 = buildTriggerDedupeKey({ ...base, workflowId: "wf-2" });
    expect(key1).not.toBe(key2);
  });
});
