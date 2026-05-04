import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { XAIPlugin } from "../index";

describe("XAIPlugin", () => {
  it("declares the xai plugin name", () => {
    expect(XAIPlugin.name).toBe("xai");
  });

  it("registers the three Grok model handlers", () => {
    expect(XAIPlugin.models).toBeDefined();
    expect(XAIPlugin.models?.[ModelType.TEXT_SMALL]).toBeTypeOf("function");
    expect(XAIPlugin.models?.[ModelType.TEXT_LARGE]).toBeTypeOf("function");
    expect(XAIPlugin.models?.[ModelType.TEXT_EMBEDDING]).toBeTypeOf("function");
  });

  it("does not register actions, services, or providers (Grok-only scope)", () => {
    expect(XAIPlugin.actions ?? []).toHaveLength(0);
    expect(XAIPlugin.services ?? []).toHaveLength(0);
    expect(XAIPlugin.providers ?? []).toHaveLength(0);
    expect(XAIPlugin.evaluators ?? []).toHaveLength(0);
  });
});
