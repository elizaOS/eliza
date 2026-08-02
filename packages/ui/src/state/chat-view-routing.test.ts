/** Deterministic coverage for chat response-context routing across built-in and dynamic views. */

import { describe, expect, it } from "vitest";
import {
  buildChatViewMetadata,
  resolveChatViewRouting,
} from "./chat-view-routing";

describe("resolveChatViewRouting", () => {
  it("routes the orchestrator path independently of the selected tab", () => {
    expect(resolveChatViewRouting("chat", "/orchestrator/task-7")).toEqual({
      view: "orchestrator",
      primaryContext: "code",
      secondaryContexts: ["admin", "documents"],
      capabilities: [
        "orchestrator-task",
        "coding-agent",
        "task-history",
        "workspace-control",
      ],
    });
  });

  it("derives a dynamic view name from its normalized route", () => {
    expect(
      resolveChatViewRouting("views", "calendar/?day=today"),
    ).toMatchObject({
      view: "calendar",
      primaryContext: "apps",
      capabilities: ["view-actions", "inspect-view", "navigate-view"],
    });
  });

  it("groups runtime diagnostics under the system context", () => {
    expect(resolveChatViewRouting("logs", "/logs")).toMatchObject({
      view: "system",
      primaryContext: "system",
    });
  });
});

describe("buildChatViewMetadata", () => {
  it("preserves caller metadata and merges unique normalized contexts", () => {
    expect(
      buildChatViewMetadata(
        "documents",
        {
          requestId: "request-1",
          __responseContext: {
            secondaryContexts: ["ADMIN", "character", "admin"],
            caller: "composer",
          },
        },
        "/documents?source=chat",
      ),
    ).toEqual({
      requestId: "request-1",
      uiView: "character",
      uiTab: "documents",
      uiViewPath: "/documents",
      uiViewCapabilities: [
        "search-documents",
        "add-documents",
        "modify-character",
      ],
      __responseContext: {
        caller: "composer",
        primaryContext: "documents",
        secondaryContexts: ["character", "admin", "documents"],
      },
    });
  });
});
