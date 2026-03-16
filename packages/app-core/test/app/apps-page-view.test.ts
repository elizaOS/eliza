import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AppsPageContextStub {
  appsSubTab: "browse" | "games";
  activeGameViewerUrl: string;
  setState: (key: string, value: "browse" | "games") => void;
}

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/components/AppsView", () => ({
  AppsView: () => React.createElement("div", null, "APPS_VIEW"),
}));

vi.mock("@elizaos/app-core/components/GameView", () => ({
  GameView: () => React.createElement("div", null, "GAME_VIEW"),
}));

import { AppsPageView } from "@elizaos/app-core/components/AppsPageView";

function createContext(
  overrides?: Partial<AppsPageContextStub>,
): AppsPageContextStub {
  return {
    appsSubTab: "browse",
    activeGameViewerUrl: "",
    setState: vi.fn<AppsPageContextStub["setState"]>(),
    ...overrides,
  };
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : ""))
    .join("")
    .trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("AppsPageView", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders app browser surface without Browse/Games tabs", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsPageView));
    });
    await flush();

    const root = tree?.root;
    expect(root.findAll((node) => text(node) === "APPS_VIEW").length).toBe(1);
    expect(root.findAll((node) => text(node) === "GAME_VIEW").length).toBe(0);
    expect(root.findAll((node) => text(node) === "Browse").length).toBe(0);
    expect(root.findAll((node) => text(node) === "Games").length).toBe(0);
  });

  it("renders full-screen game mode when a game is active", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        appsSubTab: "games",
        activeGameViewerUrl: "http://localhost:5175/viewer",
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsPageView));
    });
    await flush();

    const root = tree?.root;
    expect(root.findAll((node) => text(node) === "GAME_VIEW").length).toBe(1);
    expect(root.findAll((node) => text(node) === "APPS_VIEW").length).toBe(0);
  });

  it("falls back to app browser when game mode has no active viewer", async () => {
    const ctx = createContext({
      appsSubTab: "games",
      activeGameViewerUrl: "",
    });
    mockUseApp.mockReturnValue(ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsPageView));
    });
    await flush();

    const root = tree?.root;
    expect(root.findAll((node) => text(node) === "APPS_VIEW").length).toBe(1);
    expect(ctx.setState).toHaveBeenCalledWith("appsSubTab", "browse");
  });
});
