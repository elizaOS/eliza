/**
 * Unit tests for terminal capabilities: validates classifyTerminalSupport policy.
 */
import { describe, expect, it } from "vitest";
import {
  classifyTerminalSupport,
  ORCHESTRATOR_TOOL_NAMES,
} from "./terminal-capabilities.ts";

describe("terminal-capabilities", () => {
  it("includes essential developer tools in tool names list", () => {
    expect(ORCHESTRATOR_TOOL_NAMES).toContain("sh");
    expect(ORCHESTRATOR_TOOL_NAMES).toContain("git");
    expect(ORCHESTRATOR_TOOL_NAMES).toContain("bun");
    expect(ORCHESTRATOR_TOOL_NAMES).toContain("claude");
    expect(ORCHESTRATOR_TOOL_NAMES).toContain("codex");
  });

  it("rejects store builds with store_build reason", () => {
    const res = classifyTerminalSupport({ buildVariant: "store" });
    expect(res.supported).toBe(false);
    expect(res.reason).toBe("store_build");
  });

  it("rejects iOS platform with vanilla_mobile reason", () => {
    const res = classifyTerminalSupport({ platform: "ios" });
    expect(res.supported).toBe(false);
    expect(res.reason).toBe("vanilla_mobile");
  });

  it("supports standard non-store desktop environments", () => {
    const res = classifyTerminalSupport({
      platform: "macos",
      buildVariant: "standalone",
    });
    expect(res.supported).toBe(true);
  });
});
