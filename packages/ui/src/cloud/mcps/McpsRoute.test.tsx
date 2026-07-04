// @vitest-environment jsdom

/**
 * `McpsSurface` session resolution: the MCPs view renders when the session
 * exists only as the persisted JWT (the page-reload reality, no Steward
 * provider mounted), stays gated with no persisted session, and rejects an
 * expired token. The i18n provider and `McpsView` are stubbed to isolate the gate.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./McpsView", () => ({
  McpsView: () => <div data-testid="mcps-view">MCPs view</div>,
}));

import { McpsSurface } from "./McpsRoute";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

let storage: Storage;

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("McpsSurface session resolution", () => {
  it("renders the MCPs view when the session exists only as the persisted JWT", () => {
    storage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );

    render(<McpsSurface />);

    expect(screen.getByTestId("mcps-view")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading MCPs" })).toBeNull();
  });

  it("keeps the surface gated when no persisted session exists", () => {
    render(<McpsSurface />);

    expect(screen.getByRole("status", { name: "Loading MCPs" })).toBeTruthy();
    expect(screen.queryByTestId("mcps-view")).toBeNull();
  });

  it("does not accept an expired persisted JWT", () => {
    storage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) - 600 }),
    );

    render(<McpsSurface />);

    expect(screen.getByRole("status", { name: "Loading MCPs" })).toBeTruthy();
    expect(screen.queryByTestId("mcps-view")).toBeNull();
  });
});
