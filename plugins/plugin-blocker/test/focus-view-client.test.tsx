// @vitest-environment jsdom
/**
 * FocusView default-fetcher tests. The website-blocker route is read by the
 * shared app client through its authenticated `fetch` (client-agent.ts
 * `getWebsiteBlockerStatus`), and the agent API requires an authenticated
 * caller on a paired or remote agent, so the view's status read must go
 * through the shared client — the selected agent's API base, credentials
 * and transport — like the assistant views fixed in #34941 and the
 * Documents view in #35323, never through global fetch on
 * `client.getBaseUrl()`. The shared client and the spatial renderer are
 * replaced at the module boundary so the test reads the snapshot FocusView
 * hands to its renderer and records which transport the default fetcher
 * used.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusSnapshot } from "../src/components/focus/FocusSpatialView.tsx";

const snapshots: FocusSnapshot[] = [];
const clientFetch = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  client: {
    fetch: clientFetch,
    getBaseUrl: () => "https://agent.example",
    stopWebsiteBlock: vi.fn(async () => ({ success: true })),
    getAuthorityRevision: () => 0,
    createConversation: vi.fn(),
    sendConversationMessage: vi.fn(),
  },
}));

vi.mock("../src/components/focus/FocusSpatialView.tsx", () => ({
  FocusSpatialView: (props: { snapshot: FocusSnapshot }) => {
    snapshots.push(props.snapshot);
    return null;
  },
}));

const { FocusView } = await import("../src/components/focus/FocusView.tsx");

const STATUS_WIRE = {
  available: true,
  active: true,
  hostsFilePath: "/etc/hosts",
  startedAt: "2026-10-11T00:00:00.000Z",
  endsAt: "2026-10-11T01:00:00.000Z",
  websites: ["example.com"],
  blockedWebsites: ["example.com"],
  allowedWebsites: [],
  requestedWebsites: ["example.com"],
  matchMode: "exact",
  managedBy: null,
  metadata: null,
  scheduledByAgentId: null,
  canUnblockEarly: true,
  requiresElevation: false,
  engine: "hosts-file",
  platform: "darwin",
  supportsElevationPrompt: false,
  elevationPromptMethod: null,
};

const globalFetch = vi.fn(async () => {
  return {
    ok: true,
    status: 200,
    json: async () => STATUS_WIRE,
  } as Response;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  snapshots.length = 0;
  clientFetch.mockReset();
  clientFetch.mockImplementation(async () => STATUS_WIRE);
  globalFetch.mockClear();
  vi.stubGlobal("fetch", globalFetch);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("FocusView default fetchers", () => {
  it("loads the website-blocker status through the shared client, never global fetch", async () => {
    await act(async () => {
      root.render(<FocusView />);
    });

    const last = snapshots.at(-1);
    expect(last?.phase).toBe("active");
    expect(last?.blockedWebsites).toEqual(["example.com"]);
    expect(last?.canUnblockEarly).toBe(true);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(clientFetch).toHaveBeenCalledWith(
      "/api/website-blocker",
      { method: "GET", signal: expect.any(AbortSignal) },
      { timeoutMs: 15_000 },
    );
  });
});
