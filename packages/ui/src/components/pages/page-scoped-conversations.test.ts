/**
 * Unit coverage for page-scoped-conversations: browser intro-copy selection by
 * Agent Browser Bridge state, page-scope tagging predicates, metadata/routing
 * builders, and the reuse/update/create reconciliation decisions of
 * resolve/reset against a mocked conversations API boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../api/client-types-chat";
import type { ConversationMetadata } from "../../api/client-types-core";

vi.mock("../../api", () => ({
  client: {
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

import { client } from "../../api";
import {
  buildPageScopedConversationMetadata,
  buildPageScopedRoutingMetadata,
  getBrowserPageScopeCopy,
  isPageScopedConversation,
  isPageScopedConversationMetadata,
  PAGE_SCOPE_VERSION,
  resetPageScopedConversation,
  resolvePageScopedConversation,
} from "./page-scoped-conversations";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "Browser",
    roomId: "r1",
    createdAt: "2026-08-24T10:00:00Z",
    updatedAt: "2026-08-24T10:00:00Z",
    ...overrides,
  };
}

const mocked = {
  listConversations: vi.mocked(client.listConversations),
  createConversation: vi.mocked(client.createConversation),
  updateConversation: vi.mocked(client.updateConversation),
  deleteConversation: vi.mocked(client.deleteConversation),
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("isPageScopedConversation", () => {
  it("rejects nullish conversations and missing metadata", () => {
    expect(isPageScopedConversation(null)).toBe(false);
    expect(isPageScopedConversation(undefined)).toBe(false);
    expect(
      isPageScopedConversation(makeConversation({ metadata: undefined })),
    ).toBe(false);
  });

  it("accepts page- prefixed scopes and rejects bare scopes", () => {
    expect(
      isPageScopedConversation(
        makeConversation({ metadata: { scope: "page-wallet" } }),
      ),
    ).toBe(true);
    expect(
      isPageScopedConversation(
        makeConversation({ metadata: { scope: "general" } }),
      ),
    ).toBe(false);
  });

  it("rejects non-string scopes at runtime", () => {
    const hostile = makeConversation({
      metadata: { scope: 42 } as unknown as ConversationMetadata,
    });
    expect(isPageScopedConversation(hostile)).toBe(false);
  });
});

describe("isPageScopedConversationMetadata", () => {
  it("mirrors the predicate for raw metadata", () => {
    expect(isPageScopedConversationMetadata(null)).toBe(false);
    expect(isPageScopedConversationMetadata(undefined)).toBe(false);
    expect(isPageScopedConversationMetadata({ scope: "page-phone" })).toBe(
      true,
    );
    expect(isPageScopedConversationMetadata({ scope: "general" })).toBe(false);
  });
});

describe("buildPageScopedConversationMetadata", () => {
  it("emits scope alone when no options are given", () => {
    const metadata = buildPageScopedConversationMetadata("page-apps");
    expect(metadata).toEqual({ scope: "page-apps" });
    expect("pageId" in metadata).toBe(false);
    expect("sourceConversationId" in metadata).toBe(false);
  });

  it("stamps pageId and sourceConversationId only when provided", () => {
    const metadata = buildPageScopedConversationMetadata("page-browser", {
      pageId: "p1",
      sourceConversationId: "c9",
    });
    expect(metadata).toEqual({
      scope: "page-browser",
      pageId: "p1",
      sourceConversationId: "c9",
    });
  });
});

describe("buildPageScopedRoutingMetadata", () => {
  it("routes the browser scope with its context list and version stamp", () => {
    const routing = buildPageScopedRoutingMetadata("page-browser");
    expect(routing.taskId).toBe("page-browser");
    expect(routing.surface).toBe("page-scoped");
    expect(routing.surfaceVersion).toBe(PAGE_SCOPE_VERSION);
    expect(routing.__responseContext).toEqual({
      primaryContext: "browser",
      secondaryContexts: ["page", "page-browser", "browser", "documents"],
    });
  });

  it("routes other scopes through their own contexts", () => {
    const routing = buildPageScopedRoutingMetadata("page-connectors");
    expect(routing.__responseContext).toEqual({
      primaryContext: "connectors",
      secondaryContexts: [
        "page",
        "page-connectors",
        "connectors",
        "social_posting",
      ],
    });
  });

  it("adds pageId and sourceConversationId at the top level when provided", () => {
    const routing = buildPageScopedRoutingMetadata("page-wallet", {
      pageId: "p2",
      sourceConversationId: "c3",
    });
    expect(routing.pageId).toBe("p2");
    expect(routing.sourceConversationId).toBe("c3");
    expect("pageId" in buildPageScopedRoutingMetadata("page-wallet")).toBe(
      false,
    );
  });
});

describe("getBrowserPageScopeCopy", () => {
  it("describes the connected bridge with fallback label Chrome", () => {
    const copy = getBrowserPageScopeCopy({ browserBridgeConnected: true });
    expect(copy.title).toBe("Browser chat");
    expect(copy.body).toContain("Agent Browser Bridge is connected in Chrome.");
  });

  it("trims labels and joins browser / profile when both exist", () => {
    const copy = getBrowserPageScopeCopy({
      browserBridgeConnected: true,
      browserLabel: "  Brave  ",
      profileLabel: " Work ",
    });
    expect(copy.body).toContain("connected in Brave / Work.");
    expect(copy.systemAddendum).toContain(
      "Agent Browser Bridge is connected in Brave / Work.",
    );
  });

  it("falls back to Chrome when the browser label is blank", () => {
    const copy = getBrowserPageScopeCopy({
      browserBridgeConnected: true,
      browserLabel: "   ",
      profileLabel: null,
    });
    expect(copy.body).toContain("connected in Chrome.");
  });

  it("uses the embedded-browser copy when install is unavailable", () => {
    const copy = getBrowserPageScopeCopy({
      browserBridgeConnected: false,
      browserBridgeInstallAvailable: false,
    });
    expect(copy.body).toContain("embedded browser");
    expect(copy.systemAddendum).toContain(
      "Agent Browser Bridge is not available in this runtime",
    );
  });

  it("asks to connect the extension in the default state", () => {
    const copy = getBrowserPageScopeCopy({ browserBridgeConnected: false });
    expect(copy.title).toBe("Connect your browser");
    expect(copy.body).toContain("Install the Eliza Browser extension");
  });
});

describe("resolvePageScopedConversation", () => {
  it("returns the newest matching conversation untouched when title and metadata agree", async () => {
    const older = makeConversation({
      id: "old",
      updatedAt: "2026-08-24T09:00:00Z",
      metadata: { scope: "page-browser" },
    });
    const newer = makeConversation({
      id: "new",
      updatedAt: "2026-08-24T11:00:00Z",
      metadata: { scope: "page-browser" },
    });
    const mismatch = makeConversation({
      id: "other-scope",
      updatedAt: "2026-08-24T12:00:00Z",
      metadata: { scope: "general" },
    });
    mocked.listConversations.mockResolvedValue({
      conversations: [mismatch, older, newer],
    });

    const result = await resolvePageScopedConversation({
      scope: "page-browser",
    });

    expect(result).toBe(newer);
    expect(mocked.updateConversation).not.toHaveBeenCalled();
    expect(mocked.createConversation).not.toHaveBeenCalled();
  });

  it("updates the existing row when the title drifted", async () => {
    const existing = makeConversation({
      id: "drift",
      title: "Old name",
      metadata: { scope: "page-browser", pageId: "p1" },
    });
    mocked.listConversations.mockResolvedValue({ conversations: [existing] });
    const updated = makeConversation({ id: "drift", title: "Browser" });
    mocked.updateConversation.mockResolvedValue({ conversation: updated });

    const result = await resolvePageScopedConversation({
      scope: "page-browser",
      pageId: "p1",
    });

    expect(result).toBe(updated);
    expect(mocked.updateConversation).toHaveBeenCalledWith("drift", {
      title: "Browser",
      metadata: { scope: "page-browser", pageId: "p1" },
    });
    expect(mocked.createConversation).not.toHaveBeenCalled();
  });

  it("creates a conversation with the scope default title when none matches", async () => {
    mocked.listConversations.mockResolvedValue({ conversations: [] });
    const created = makeConversation({ id: "fresh" });
    mocked.createConversation.mockResolvedValue({ conversation: created });

    const result = await resolvePageScopedConversation({
      scope: "page-settings",
    });

    expect(result).toBe(created);
    expect(mocked.createConversation).toHaveBeenCalledWith("Settings", {
      metadata: { scope: "page-settings" },
    });
    expect(mocked.updateConversation).not.toHaveBeenCalled();
  });

  it("trims the requested title and falls back to the default when blank", async () => {
    mocked.listConversations.mockResolvedValue({ conversations: [] });
    mocked.createConversation.mockResolvedValue({
      conversation: makeConversation(),
    });

    await resolvePageScopedConversation({
      scope: "page-browser",
      title: "  My Chat  ",
    });
    expect(mocked.createConversation).toHaveBeenLastCalledWith("My Chat", {
      metadata: { scope: "page-browser" },
    });

    await resolvePageScopedConversation({
      scope: "page-browser",
      title: "   ",
    });
    expect(mocked.createConversation).toHaveBeenLastCalledWith("Browser", {
      metadata: { scope: "page-browser" },
    });
  });
});

describe("resetPageScopedConversation", () => {
  it("deletes every matching conversation, then creates a fresh one", async () => {
    mocked.listConversations.mockResolvedValue({
      conversations: [
        makeConversation({
          id: "a",
          metadata: { scope: "page-browser", pageId: "p1" },
        }),
        makeConversation({
          id: "b",
          metadata: { scope: "page-browser", pageId: "p1" },
        }),
        makeConversation({ id: "keep", metadata: { scope: "page-character" } }),
        makeConversation({
          id: "other-page",
          metadata: { scope: "page-browser", pageId: "p2" },
        }),
      ],
    });
    const fresh = makeConversation({ id: "new-seed" });
    mocked.createConversation.mockResolvedValue({ conversation: fresh });

    const result = await resetPageScopedConversation({
      scope: "page-browser",
      pageId: "p1",
    });

    expect(result).toBe(fresh);
    expect(mocked.deleteConversation).toHaveBeenCalledTimes(2);
    expect(mocked.deleteConversation).toHaveBeenCalledWith("a");
    expect(mocked.deleteConversation).toHaveBeenCalledWith("b");
    expect(mocked.createConversation).toHaveBeenCalledWith("Browser", {
      metadata: { scope: "page-browser", pageId: "p1" },
    });
  });

  it("still creates a fresh conversation when a deletion fails", async () => {
    mocked.listConversations.mockResolvedValue({
      conversations: [
        makeConversation({ id: "gone", metadata: { scope: "page-apps" } }),
      ],
    });
    mocked.deleteConversation.mockRejectedValue(new Error("already deleting"));
    const fresh = makeConversation({ id: "after-failure" });
    mocked.createConversation.mockResolvedValue({ conversation: fresh });

    const result = await resetPageScopedConversation({ scope: "page-apps" });

    expect(result).toBe(fresh);
    expect(mocked.createConversation).toHaveBeenCalled();
  });

  it("skips deletion entirely when nothing matches", async () => {
    mocked.listConversations.mockResolvedValue({ conversations: [] });
    mocked.createConversation.mockResolvedValue({
      conversation: makeConversation({ id: "only" }),
    });

    await resetPageScopedConversation({ scope: "page-plugins" });

    expect(mocked.deleteConversation).not.toHaveBeenCalled();
    expect(mocked.createConversation).toHaveBeenCalledWith("Plugins", {
      metadata: { scope: "page-plugins" },
    });
  });
});
