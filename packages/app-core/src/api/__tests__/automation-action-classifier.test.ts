import { describe, expect, it, vi } from "vitest";

const hasActionTags = vi.fn();
vi.mock("@elizaos/core", () => ({
  hasActionTags: (...args: unknown[]) => hasActionTags(...args),
}));

import { classifyRuntimeActionNode } from "../automation-action-classifier.ts";

describe("classifyRuntimeActionNode", () => {
  it("classifies agent-orchestration + delegate actions as agent", () => {
    hasActionTags.mockReturnValue(true);
    expect(classifyRuntimeActionNode({ tags: [] } as never)).toBe("agent");
  });

  it("classifies everything else as action", () => {
    hasActionTags.mockReturnValue(false);
    expect(classifyRuntimeActionNode({ tags: [] } as never)).toBe("action");
  });
});
