/** Shared-runtime view and greeting routes reject malformed path encoding. */

import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/mobile-push/types", () => ({
  MAX_MOBILE_PUSH_TOKEN_CHARACTERS: 4096,
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  coordinateSharedPushList: async () => ({}),
  coordinateSharedPushRegister: async () => ({}),
  coordinateSharedPushUnregister: async () => ({}),
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedAgent: async () => ({ error: "unauthorized", status: 401 }),
  resolveSharedRuntimeWorkerRequestContext: () => ({
    error: "unauthorized",
    status: 401,
  }),
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestAgentEvents: () => ({}),
  sharedRestAgentStart: () => ({}),
  sharedRestAuthMe: () => ({}),
  sharedRestCharacter: () => ({}),
  sharedRestCommands: () => ({}),
  sharedRestConfig: () => ({}),
  sharedRestCustomActions: () => ({}),
  sharedRestFirstRun: () => ({}),
  sharedRestFirstRunStatus: () => ({}),
  sharedRestFirstRunSubmit: () => ({}),
  sharedRestGreeting: () => ({}),
  sharedRestOverlayPresence: () => ({}),
  sharedRestRuntimeMode: () => ({}),
  sharedRestStatus: () => ({}),
  sharedRestStreamSettings: () => ({}),
  sharedRestViewNavigate: () => ({}),
  sharedRestViews: () => ({}),
}));
mock.module("../../workflows/_shared", () => ({
  workflowRuntimeUnavailableResponse: () =>
    Response.json({ success: false }, { status: 409 }),
}));

const { greetingConversationId, viewNavigateTarget } = await import("./route");

describe("shared-runtime catch-all path encoding", () => {
  test("viewNavigateTarget returns null for a lone %", () => {
    expect(viewNavigateTarget("views/%/navigate")).toBeNull();
  });

  test("viewNavigateTarget returns null for %ZZ", () => {
    expect(viewNavigateTarget("views/%ZZ/navigate")).toBeNull();
  });

  test("viewNavigateTarget returns null for truncated UTF-8", () => {
    expect(viewNavigateTarget("views/%E0%A4%A/navigate")).toBeNull();
  });

  test("viewNavigateTarget still decodes a valid %20 view id", () => {
    expect(viewNavigateTarget("views/chat%20home/navigate")).toBe("chat home");
  });

  test("greetingConversationId returns null for a lone %", () => {
    expect(greetingConversationId("conversations/%/greeting")).toBeNull();
  });

  test("greetingConversationId still decodes a valid %2D conversation id", () => {
    expect(greetingConversationId("conversations/conv%2D1/greeting")).toBe(
      "conv-1",
    );
  });
});
