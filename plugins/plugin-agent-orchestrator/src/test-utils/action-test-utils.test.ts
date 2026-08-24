/**
 * Unit tests for action test utils: validates test session builder and mock runtime factory.
 */
import { describe, expect, it } from "vitest";
import { serviceMock, session } from "./action-test-utils.ts";

describe("action-test-utils", () => {
  it("creates default session info with expected defaults", () => {
    const s = session();
    expect(s.id).toBe("abcdef123456");
    expect(s.name).toBe("agent-one");
    expect(s.agentType).toBe("codex");
    expect(s.status).toBe("ready");
  });

  it("allows overriding specific session fields", () => {
    const s = session({ id: "custom-id", agentType: "claude" });
    expect(s.id).toBe("custom-id");
    expect(s.agentType).toBe("claude");
    expect(s.name).toBe("agent-one");
  });

  it("creates serviceMock with mock methods", () => {
    const mock = serviceMock();
    expect(typeof mock.spawnSession).toBe("function");
    expect(typeof mock.sendPrompt).toBe("function");
    expect(typeof mock.stopSession).toBe("function");
  });
});
