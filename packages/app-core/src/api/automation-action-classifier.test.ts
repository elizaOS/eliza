/**
 * Tests `classifyRuntimeActionNode`: a runtime action becomes an `"agent"`
 * automation node only when it declares both `domain:agent-orchestration` and
 * `capability:delegate`. Everything else, including missing or partial tags,
 * stays in the `"action"` class. Drives the real helper through real
 * `@elizaos/core` `hasActionTags` matching — no mocks.
 */
import { describe, expect, it } from "vitest";
import { classifyRuntimeActionNode } from "./automation-action-classifier.ts";

describe("classifyRuntimeActionNode", () => {
  it("classifies an action that declares both required tags as agent", () => {
    expect(
      classifyRuntimeActionNode({
        tags: ["domain:agent-orchestration", "capability:delegate"],
      }),
    ).toBe("agent");
  });

  it("classifies the orchestrator TASKS tag set as agent", () => {
    expect(
      classifyRuntimeActionNode({
        tags: [
          "domain:coding",
          "domain:agent-orchestration",
          "resource:agent-task",
          "capability:delegate",
        ],
      }),
    ).toBe("agent");
  });

  it("does not depend on required-tag order", () => {
    expect(
      classifyRuntimeActionNode({
        tags: ["capability:delegate", "domain:agent-orchestration"],
      }),
    ).toBe("agent");
  });

  it("matches required tags case-insensitively", () => {
    expect(
      classifyRuntimeActionNode({
        tags: ["Domain:Agent-Orchestration", "Capability:Delegate"],
      }),
    ).toBe("agent");
  });

  it("still classifies as agent when required tags are duplicated", () => {
    expect(
      classifyRuntimeActionNode({
        tags: [
          "domain:agent-orchestration",
          "domain:agent-orchestration",
          "capability:delegate",
          "capability:delegate",
        ],
      }),
    ).toBe("agent");
  });

  it("keeps an action with only the orchestration domain tag in the action class", () => {
    expect(
      classifyRuntimeActionNode({
        tags: ["domain:agent-orchestration"],
      }),
    ).toBe("action");
  });

  it("keeps an action with only the delegate capability tag in the action class", () => {
    expect(
      classifyRuntimeActionNode({
        tags: ["capability:delegate"],
      }),
    ).toBe("action");
  });

  it("keeps an empty tag list in the action class", () => {
    expect(classifyRuntimeActionNode({ tags: [] })).toBe("action");
  });

  it("treats a missing tags field as an empty list and returns action", () => {
    expect(classifyRuntimeActionNode({})).toBe("action");
  });

  it("keeps unrelated tags in the action class", () => {
    expect(
      classifyRuntimeActionNode({
        tags: ["domain:settings", "capability:write"],
      }),
    ).toBe("action");
  });

  it("does not treat prefix or substring lookalikes as the required tags", () => {
    expect(
      classifyRuntimeActionNode({
        tags: ["domain:agent-orchestration-extra", "capability:delegate-extra"],
      }),
    ).toBe("action");
    expect(
      classifyRuntimeActionNode({
        tags: ["domain:agent-orchestrator", "capability:delegated"],
      }),
    ).toBe("action");
  });

  it("does not match required tags padded with whitespace", () => {
    expect(
      classifyRuntimeActionNode({
        tags: [" domain:agent-orchestration", "capability:delegate "],
      }),
    ).toBe("action");
  });
});
