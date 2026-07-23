/**
 * Pins the narrow global-auth bypass used by shared-agent model requests; all
 * neighboring management and history routes must remain globally gated.
 */

import { describe, expect, test } from "bun:test";
import { isRouteAuthenticatedInferencePath } from "./auth";

describe("isRouteAuthenticatedInferencePath", () => {
  test.each([
    "/api/v1/eliza/agents/agent-1/stream",
    "/api/v1/eliza/agents/agent-1/bridge",
    "/api/v1/eliza/agents/agent-1/api/conversations/conversation-1/messages",
    "/api/v1/eliza/agents/agent-1/api/conversations/conversation-1/messages/stream",
  ])("allows the route-local cache-only inference gate for %s", (path) => {
    expect(isRouteAuthenticatedInferencePath("POST", path)).toBe(true);
    expect(isRouteAuthenticatedInferencePath("OPTIONS", path)).toBe(true);
  });

  test.each([
    "/api/v1/eliza/agents/agent-1",
    "/api/v1/eliza/agents/agent-1/api/conversations",
    "/api/v1/eliza/agents/agent-1/api/conversations/conversation-1/messages/extra",
    "/api/v1/eliza/agents/agent-1/suspend",
  ])("does not bypass global auth for %s", (path) => {
    expect(isRouteAuthenticatedInferencePath("POST", path)).toBe(false);
  });

  test("never bypasses a state-reading verb", () => {
    expect(
      isRouteAuthenticatedInferencePath(
        "GET",
        "/api/v1/eliza/agents/agent-1/api/conversations/conversation-1/messages",
      ),
    ).toBe(false);
  });
});
