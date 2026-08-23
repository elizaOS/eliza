import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionProviders: vi.fn(() => []),
  resolveStateDir: vi.fn(() => "/state"),
}));

vi.mock("@elizaos/core", () => ({
  getSessionProviders: () => mocks.getSessionProviders(),
  resolveStateDir: () => mocks.resolveStateDir(),
}));

import {
  getSessionProviders,
  resolveDefaultSessionStorePath,
} from "../session-utils.ts";

describe("resolveDefaultSessionStorePath", () => {
  it("resolves the sessions.json path under the state dir", () => {
    expect(resolveDefaultSessionStorePath("agent-1")).toBe(
      "/state/agents/agent-1/sessions/sessions.json",
    );
  });

  it("defaults to the main agent", () => {
    expect(resolveDefaultSessionStorePath()).toBe(
      "/state/agents/main/sessions/sessions.json",
    );
  });
});

describe("getSessionProviders", () => {
  it("re-exports the canonical providers", () => {
    expect(getSessionProviders()).toEqual([]);
  });
});
