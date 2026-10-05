// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock(
  "@elizaos/plugin-elizacloud/steward-session-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@elizaos/plugin-elizacloud/steward-session-client")
    >()),
    readStoredStewardToken: () => "fixture-owner-token",
    writeStoredStewardToken: vi.fn(),
    clearStoredStewardToken: vi.fn(),
    hasStewardAuthedCookie: () => false,
  }),
);

import {
  buildCloudSharedAgentApiBase,
  buildDedicatedCloudAgentApiBase,
  clearPersistedActiveServer,
  loadPersistedActiveServer,
  type PersistedActiveServer,
  savePersistedActiveServer,
} from "@elizaos/ui";
import { applyRestoredConnection } from "./startup-phase-restore";

const id = "11111111-1111-4111-8111-111111111111";
const active: PersistedActiveServer = {
  id: `cloud:${id}`,
  kind: "cloud",
  label: "Existing cloud agent",
  apiBase:
    buildDedicatedCloudAgentApiBase(id, "https://eliza.app") ?? undefined,
};
beforeEach(() => {
  localStorage.clear();
  savePersistedActiveServer(active);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
test("an existing shared bridge saved as dedicated restores using authenticated owner evidence", async () => {
  const fetcher = vi.fn(
    async (_url: string, _options: RequestInit) =>
      new Response(JSON.stringify({ data: { executionTier: "shared" } })),
  );
  vi.stubGlobal("fetch", fetcher);
  const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };
  await applyRestoredConnection({ restoredActiveServer: active, clientRef });
  await vi.waitFor(() =>
    expect(clientRef.setBaseUrl).toHaveBeenLastCalledWith(
      buildCloudSharedAgentApiBase("https://api.eliza.app", id),
    ),
  );
  expect(
    new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization"),
  ).toBe("Bearer fixture-owner-token");
  expect(clientRef.setToken).toHaveBeenLastCalledWith("fixture-owner-token");
});
test("a delayed tier lookup cannot replace the user's newer target", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };
  await applyRestoredConnection({ restoredActiveServer: active, clientRef });
  expect(resolve).toBeTypeOf("function");
  const newer = {
    id: "remote:new",
    kind: "remote" as const,
    label: "New selection",
    apiBase: "http://127.0.0.1:3333",
  };
  savePersistedActiveServer(newer);
  clientRef.setBaseUrl.mockClear();
  resolve(new Response(JSON.stringify({ data: { executionTier: "shared" } })));
  await new Promise((done) => setTimeout(done, 20));
  expect(loadPersistedActiveServer()?.id).toBe(newer.id);
  expect(clientRef.setBaseUrl).not.toHaveBeenCalled();
});

test("a delayed tier lookup cannot restore a logged-out selection", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };
  await applyRestoredConnection({ restoredActiveServer: active, clientRef });
  clearPersistedActiveServer();
  clientRef.setBaseUrl.mockClear();
  clientRef.setToken.mockClear();
  resolve(new Response(JSON.stringify({ data: { executionTier: "shared" } })));
  await new Promise((done) => setTimeout(done, 20));
  expect(loadPersistedActiveServer()).toBeNull();
  expect(clientRef.setBaseUrl).not.toHaveBeenCalled();
  expect(clientRef.setToken).not.toHaveBeenCalled();
});
