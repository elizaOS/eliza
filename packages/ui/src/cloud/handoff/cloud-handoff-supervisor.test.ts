/**
 * Unit coverage for the cloud conversation-handoff supervisor (start + drive the
 * handoff) against an injected authed fetch. No live cloud.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type AuthedAgentFetch,
  startCloudConversationHandoff,
} from "./cloud-handoff-supervisor";

const SHARED = "https://elizacloud.ai/api/v1/eliza/agents/agent-1/api";
const CONTAINER = "https://agent-1.elizacloud.ai";
const CONV = "agent-1";

describe("startCloudConversationHandoff", () => {
  it("polls readiness, reads shared, imports to the container, then switches", async () => {
    let readyCalls = 0;
    const resolveReadyBase = vi.fn(async () => {
      readyCalls += 1;
      return readyCalls >= 2 ? CONTAINER : null;
    });

    const authedFetch: AuthedAgentFetch = vi.fn(async (base, path) => {
      if (base === SHARED && path.endsWith("/messages")) {
        return {
          status: 200,
          json: {
            messages: [
              { role: "user", text: "hi", timestamp: 1 },
              { role: "assistant", text: "hello", timestamp: 2 },
            ],
          },
        };
      }
      if (base === CONTAINER && path.endsWith("/import")) {
        return { status: 200, json: { inserted: 2 } };
      }
      throw new Error(`unexpected fetch ${base}${path}`);
    });

    const onSwitch = vi.fn();

    const result = await startCloudConversationHandoff({
      sharedApiBase: SHARED,
      conversationId: CONV,
      readiness: { resolveReadyBase },
      authedFetch,
      onSwitch,
      intervalMs: 1,
      timeoutMs: 1_000,
      // deterministic clock for the readiness poll
    });

    expect(result).toEqual({ status: "switched", imported: 2 });
    // read from shared, import to container, switch to container
    expect(authedFetch).toHaveBeenCalledWith(
      SHARED,
      `/api/conversations/${CONV}/messages`,
    );
    expect(authedFetch).toHaveBeenCalledWith(
      CONTAINER,
      `/api/conversations/${CONV}/import`,
      { method: "POST", body: { messages: expect.any(Array) } },
    );
    expect(onSwitch).toHaveBeenCalledWith(CONTAINER);
  });

  it("fails closed (no switch) when the import errors", async () => {
    const authedFetch: AuthedAgentFetch = vi.fn(async (_base, path) => {
      if (path.endsWith("/messages")) {
        return {
          status: 200,
          json: { messages: [{ role: "user", text: "x" }] },
        };
      }
      return { status: 500, json: { error: "boom" } };
    });
    const onSwitch = vi.fn();

    const result = await startCloudConversationHandoff({
      sharedApiBase: SHARED,
      conversationId: CONV,
      readiness: { resolveReadyBase: async () => CONTAINER },
      authedFetch,
      onSwitch,
      intervalMs: 1,
      timeoutMs: 100,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 500");
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("switches without importing when the shared conversation is empty", async () => {
    const authedFetch: AuthedAgentFetch = vi.fn(async (_base, path) => {
      if (path.endsWith("/messages"))
        return { status: 200, json: { messages: [] } };
      throw new Error("import should not be called");
    });
    const onSwitch = vi.fn();

    const result = await startCloudConversationHandoff({
      sharedApiBase: SHARED,
      conversationId: CONV,
      readiness: { resolveReadyBase: async () => CONTAINER },
      authedFetch,
      onSwitch,
      intervalMs: 1,
      timeoutMs: 100,
    });

    expect(result.status).toBe("switched-empty");
    expect(onSwitch).toHaveBeenCalledWith(CONTAINER);
  });
});
