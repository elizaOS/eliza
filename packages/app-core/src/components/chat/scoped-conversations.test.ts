import { describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
  },
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

import type { Conversation } from "../../api/client-types-chat";
import {
  buildPageConversationMetadata,
  buildPageResponseRoutingMetadata,
  findPageScopedConversation,
  isPageScopeMetadata,
  resolveScopedConversation,
} from "./scoped-conversations";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: "conv-1",
    title: "Test",
    roomId: "room-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── isPageScopeMetadata ───────────────────────────────────────────────────────

describe("isPageScopeMetadata", () => {
  it("returns true for all five page scopes", () => {
    for (const scope of [
      "page-character",
      "page-apps",
      "page-wallet",
      "page-browser",
      "page-automations",
    ] as const) {
      expect(isPageScopeMetadata({ scope })).toBe(true);
    }
  });

  it("returns false for automation scopes", () => {
    expect(
      isPageScopeMetadata({ scope: "automation-coordinator" }),
    ).toBe(false);
  });

  it("returns false for general scope", () => {
    expect(isPageScopeMetadata({ scope: "general" })).toBe(false);
  });

  it("returns false for undefined / null", () => {
    expect(isPageScopeMetadata(undefined)).toBe(false);
    expect(isPageScopeMetadata(null)).toBe(false);
  });
});

// ── buildPageConversationMetadata ─────────────────────────────────────────────

describe("buildPageConversationMetadata", () => {
  it("builds metadata with scope only", () => {
    expect(buildPageConversationMetadata("page-apps")).toEqual({
      scope: "page-apps",
    });
  });

  it("includes pageId when provided", () => {
    expect(buildPageConversationMetadata("page-character", "char-abc")).toEqual(
      {
        scope: "page-character",
        pageId: "char-abc",
      },
    );
  });

  it("includes bridge fields when bridgeConversationId is provided", () => {
    expect(
      buildPageConversationMetadata("page-browser", undefined, "conv-main"),
    ).toEqual({
      scope: "page-browser",
      sourceConversationId: "conv-main",
      terminalBridgeConversationId: "conv-main",
    });
  });

  it("includes all three when pageId and bridge are provided", () => {
    expect(
      buildPageConversationMetadata("page-wallet", "wallet-1", "conv-main"),
    ).toEqual({
      scope: "page-wallet",
      pageId: "wallet-1",
      sourceConversationId: "conv-main",
      terminalBridgeConversationId: "conv-main",
    });
  });

  it("omits bridge fields for empty string", () => {
    const result = buildPageConversationMetadata("page-apps", undefined, "  ");
    expect(result).not.toHaveProperty("sourceConversationId");
    expect(result).not.toHaveProperty("terminalBridgeConversationId");
  });

  it("omits pageId for empty string", () => {
    const result = buildPageConversationMetadata("page-apps", "  ");
    expect(result).not.toHaveProperty("pageId");
  });
});

// ── buildPageResponseRoutingMetadata ──────────────────────────────────────────

describe("buildPageResponseRoutingMetadata", () => {
  it("includes scope in secondaryContexts", () => {
    const routing = buildPageResponseRoutingMetadata({
      scope: "page-character",
    });
    expect(routing).toEqual({
      __responseContext: {
        primaryContext: "page",
        secondaryContexts: ["page-character", "system"],
      },
    });
  });

  it("falls back to 'page' when scope is absent", () => {
    const routing = buildPageResponseRoutingMetadata({});
    expect(routing).toEqual({
      __responseContext: {
        primaryContext: "page",
        secondaryContexts: ["page", "system"],
      },
    });
  });
});

// ── findPageScopedConversation ────────────────────────────────────────────────

describe("findPageScopedConversation", () => {
  it("finds a conversation matching scope and pageId", () => {
    const target = makeConversation({
      id: "page-conv",
      metadata: { scope: "page-character", pageId: "char-1" },
    });
    const other = makeConversation({
      id: "other-conv",
      metadata: { scope: "page-character", pageId: "char-2" },
    });

    expect(
      findPageScopedConversation(
        [other, target],
        buildPageConversationMetadata("page-character", "char-1"),
      ),
    ).toBe(target);
  });

  it("finds a conversation matching scope only (no pageId)", () => {
    const target = makeConversation({
      id: "apps-conv",
      metadata: { scope: "page-apps" },
    });

    expect(
      findPageScopedConversation(
        [target],
        buildPageConversationMetadata("page-apps"),
      ),
    ).toBe(target);
  });

  it("returns null when no match exists", () => {
    const conv = makeConversation({
      metadata: { scope: "page-browser", pageId: "tab-1" },
    });

    expect(
      findPageScopedConversation(
        [conv],
        buildPageConversationMetadata("page-browser", "tab-2"),
      ),
    ).toBeNull();
  });

  it("returns null for non-page-scoped conversations", () => {
    const conv = makeConversation({
      metadata: { scope: "automation-coordinator" },
    });

    expect(
      findPageScopedConversation(
        [conv],
        buildPageConversationMetadata("page-apps"),
      ),
    ).toBeNull();
  });
});

// ── resolveScopedConversation ─────────────────────────────────────────────────

describe("resolveScopedConversation", () => {
  it("returns existing conversation when title and metadata match", async () => {
    const existing = makeConversation({
      id: "existing-1",
      title: "My Page",
      metadata: { scope: "page-apps" },
    });
    clientMock.listConversations.mockResolvedValueOnce({
      conversations: [existing],
    });

    const result = await resolveScopedConversation({
      title: "My Page",
      metadata: buildPageConversationMetadata("page-apps"),
    });

    expect(result).toBe(existing);
    expect(clientMock.updateConversation).not.toHaveBeenCalled();
    expect(clientMock.createConversation).not.toHaveBeenCalled();
  });

  it("updates conversation when title differs", async () => {
    const existing = makeConversation({
      id: "existing-1",
      title: "Old Title",
      metadata: { scope: "page-apps" },
    });
    const updated = makeConversation({
      id: "existing-1",
      title: "New Title",
      metadata: { scope: "page-apps" },
    });
    clientMock.listConversations.mockResolvedValueOnce({
      conversations: [existing],
    });
    clientMock.updateConversation.mockResolvedValueOnce({
      conversation: updated,
    });

    const result = await resolveScopedConversation({
      title: "New Title",
      metadata: buildPageConversationMetadata("page-apps"),
    });

    expect(result).toBe(updated);
    expect(clientMock.updateConversation).toHaveBeenCalledWith("existing-1", {
      title: "New Title",
      metadata: { scope: "page-apps" },
    });
  });

  it("creates a new conversation when none matches", async () => {
    clientMock.listConversations.mockResolvedValueOnce({ conversations: [] });
    const created = makeConversation({
      id: "new-conv",
      title: "Character Chat",
      metadata: { scope: "page-character", pageId: "char-1" },
    });
    clientMock.createConversation.mockResolvedValueOnce({
      conversation: created,
    });

    const metadata = buildPageConversationMetadata("page-character", "char-1");
    const result = await resolveScopedConversation({
      title: "Character Chat",
      metadata,
    });

    expect(result).toBe(created);
    expect(clientMock.createConversation).toHaveBeenCalledWith(
      "Character Chat",
      { metadata },
    );
  });

  it("propagates bridgeConversationId into metadata", async () => {
    clientMock.listConversations.mockResolvedValueOnce({ conversations: [] });
    const created = makeConversation({ id: "new-2" });
    clientMock.createConversation.mockResolvedValueOnce({
      conversation: created,
    });

    const metadata = buildPageConversationMetadata(
      "page-browser",
      undefined,
      "conv-main",
    );
    await resolveScopedConversation({ title: "Browser", metadata });

    expect(clientMock.createConversation).toHaveBeenCalledWith("Browser", {
      metadata: {
        scope: "page-browser",
        sourceConversationId: "conv-main",
        terminalBridgeConversationId: "conv-main",
      },
    });
  });
});
