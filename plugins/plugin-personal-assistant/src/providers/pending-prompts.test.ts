import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  access: { hasOwnerAccess: vi.fn() },
  store: { resolvePendingPromptsStore: vi.fn() },
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: h.access.hasOwnerAccess,
}));

vi.mock("@elizaos/core", () => ({
  logger: h.logger,
}));

vi.mock("../lifeops/pending-prompts/store.js", () => ({
  resolvePendingPromptsStore: h.store.resolvePendingPromptsStore,
}));

import { logger } from "@elizaos/core";
import {
  createPendingPromptsProvider,
  pendingPromptsProvider,
  renderPendingPromptsText,
} from "./pending-prompts";

const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

const EMPTY = {
  text: "",
  values: { pendingPromptCount: 0 },
  data: { pendingPrompts: [] },
};

const prompts = [
  {
    taskId: "task-1",
    promptSnippet: "Did you review the budget?",
    firedAt: "2026-08-25T00:00:00Z",
    expectedReplyKind: "complete",
    expiresAt: "2026-08-26T00:00:00Z",
  },
  {
    taskId: "task-2",
    promptSnippet: "Confirm the meeting time",
    firedAt: "2026-08-25T00:00:00Z",
    expectedReplyKind: "acknowledge",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("renderPendingPromptsText", () => {
  it("renders nothing for an empty prompt list", () => {
    expect(renderPendingPromptsText([])).toBe("");
  });

  it("renders one line per prompt with reply kind and optional expiry", () => {
    const text = renderPendingPromptsText(prompts);
    expect(text).toContain(
      "- task task-1: Did you review the budget? [reply=complete] (expires 2026-08-26T00:00:00Z)",
    );
    expect(text).toContain(
      "- task task-2: Confirm the meeting time [reply=acknowledge]",
    );
  });

  it("omits the expiry suffix when expiresAt is absent", () => {
    const text = renderPendingPromptsText([prompts[1]]);
    expect(text).not.toContain("(expires");
  });

  it("prefixes the routing hint header", () => {
    const text = renderPendingPromptsText(prompts);
    expect(text).toContain(
      "Open prompts in this room (route inbound to .complete/.acknowledge):",
    );
    expect(text.split("\n")).toHaveLength(3);
  });
});

describe("createPendingPromptsProvider", () => {
  it("delegates list to the resolved store", async () => {
    const storeList = vi.fn().mockResolvedValue(prompts);
    h.store.resolvePendingPromptsStore.mockReturnValue({ list: storeList });
    const provider = createPendingPromptsProvider({} as never);
    await expect(
      provider.list("room-1", { lookbackMinutes: 30 }),
    ).resolves.toBe(prompts);
    expect(storeList).toHaveBeenCalledWith("room-1", { lookbackMinutes: 30 });
  });
});

describe("pendingPromptsProvider metadata", () => {
  it("declares the provider contract", () => {
    expect(pendingPromptsProvider.name).toBe("pendingPrompts");
    expect(pendingPromptsProvider.dynamic).toBe(true);
    expect(pendingPromptsProvider.position).toBe(11);
    expect(pendingPromptsProvider.cacheScope).toBe("turn");
    expect(pendingPromptsProvider.contexts).toEqual(["messaging", "tasks"]);
  });
});

describe("pendingPromptsProvider.get", () => {
  it("returns EMPTY without owner access (privacy gate)", async () => {
    h.access.hasOwnerAccess.mockResolvedValue(false);
    const result = await pendingPromptsProvider.get?.(
      {} as never,
      { roomId: "room-1" } as never,
      {} as never,
    );
    expect(result).toEqual(EMPTY);
    expect(h.store.resolvePendingPromptsStore).not.toHaveBeenCalled();
  });

  it("returns EMPTY when the message has no room id", async () => {
    h.access.hasOwnerAccess.mockResolvedValue(true);
    const result = await pendingPromptsProvider.get?.(
      {} as never,
      { content: {} } as never,
      {} as never,
    );
    expect(result).toEqual(EMPTY);
    expect(h.store.resolvePendingPromptsStore).not.toHaveBeenCalled();
  });

  it("fails closed when the store cannot be resolved", async () => {
    h.access.hasOwnerAccess.mockResolvedValue(true);
    h.store.resolvePendingPromptsStore.mockImplementation(() => {
      throw new Error("store not wired");
    });
    const result = await pendingPromptsProvider.get?.(
      {} as never,
      { roomId: "room-1" } as never,
      {} as never,
    );
    expect(result).toEqual(EMPTY);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("store unavailable"),
      "Error: store not wired",
    );
  });

  it("fails closed when the store list call throws", async () => {
    h.access.hasOwnerAccess.mockResolvedValue(true);
    h.store.resolvePendingPromptsStore.mockReturnValue({
      list: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const result = await pendingPromptsProvider.get?.(
      {} as never,
      { roomId: "room-1" } as never,
      {} as never,
    );
    expect(result).toEqual(EMPTY);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("list failed"),
      "Error: db down",
    );
  });

  it("returns EMPTY for an empty prompt list", async () => {
    h.access.hasOwnerAccess.mockResolvedValue(true);
    h.store.resolvePendingPromptsStore.mockReturnValue({
      list: vi.fn().mockResolvedValue([]),
    });
    const result = await pendingPromptsProvider.get?.(
      {} as never,
      { roomId: "room-1" } as never,
      {} as never,
    );
    expect(result).toEqual(EMPTY);
  });

  it("renders open prompts with count and task ids for the owner", async () => {
    h.access.hasOwnerAccess.mockResolvedValue(true);
    h.store.resolvePendingPromptsStore.mockReturnValue({
      list: vi.fn().mockResolvedValue(prompts),
    });
    const result = await pendingPromptsProvider.get?.(
      {} as never,
      { roomId: "room-1" } as never,
      {} as never,
    );
    expect(result).toMatchObject({
      values: {
        pendingPromptCount: 2,
        pendingPromptTaskIds: ["task-1", "task-2"],
      },
      data: { pendingPrompts: prompts },
    });
    expect(result?.text).toContain("- task task-1:");
  });
});
