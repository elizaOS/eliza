/**
 * Exercises the main-process reset transport with deterministic fetch fakes.
 * The tests verify that authorization builders receive each actual request URL.
 */
import { describe, expect, it, vi } from "vitest";
import {
  pickReachableMenuResetApiBase,
  runMainMenuResetAfterApiBaseResolved,
} from "./menu-reset-from-main";

describe("main-process reset target authorization", () => {
  it("qualifies each reachability probe against its exact status URL", async () => {
    const buildHeaders = vi.fn(() => ({ Accept: "application/json" }));
    const fetchImpl = vi.fn(async (url: string) =>
      Promise.resolve(
        new Response("{}", {
          status: url.startsWith("https://remote.example") ? 200 : 503,
        }),
      ),
    );

    await expect(
      pickReachableMenuResetApiBase({
        candidates: ["http://127.0.0.1:31337", "https://remote.example"],
        fetchImpl,
        buildHeaders,
      }),
    ).resolves.toBe("https://remote.example");
    expect(buildHeaders.mock.calls).toEqual([
      ["http://127.0.0.1:31337/api/status"],
      ["https://remote.example/api/status"],
    ]);
  });

  it("qualifies reset, poll, and verification against their exact URLs", async () => {
    const buildHeaders = vi.fn(() => ({ Accept: "application/json" }));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/status")) {
        return new Response('{"state":"running"}', { status: 200 });
      }
      if (url.endsWith("/api/first-run/status")) {
        return new Response('{"complete":false}', { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    await runMainMenuResetAfterApiBaseResolved({
      apiBase: "https://remote.example",
      fetchImpl,
      buildHeaders,
      useEmbeddedRestart: false,
      restartEmbeddedClearingLocalDb: vi.fn(async () => ({})),
      pushEmbeddedApiBaseToRenderer: vi.fn(),
      getLocalApiAuthToken: vi.fn(() => ""),
      postExternalAgentRestart: vi.fn(async () => undefined),
      resolveApiBaseForStatusPoll: () => "https://remote.example",
      sendMenuResetAppliedToRenderer: vi.fn(),
    });

    expect(buildHeaders.mock.calls).toEqual([
      ["https://remote.example/api/agent/reset"],
      ["https://remote.example/api/status"],
      ["https://remote.example/api/first-run/status"],
    ]);
  });
});
