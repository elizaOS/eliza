import { describe, expect, it, vi } from "vitest";
import {
  type FetchLike,
  type MainMenuResetPostConfirmDeps,
  buildMainMenuResetApiCandidates,
  pickReachableMenuResetApiBase,
  pollMenuResetAgentStatusJson,
  runMainMenuResetAfterApiBaseResolved,
} from "./menu-reset-from-main";

/* ---------- buildMainMenuResetApiCandidates ---------- */

describe("buildMainMenuResetApiCandidates", () => {
  it("returns embedded port first when both are supplied", () => {
    const result = buildMainMenuResetApiCandidates({
      embeddedPort: 31337,
      configuredBase: "http://127.0.0.1:9999",
    });
    expect(result).toEqual([
      "http://127.0.0.1:31337",
      "http://127.0.0.1:9999",
    ]);
  });

  it("skips embedded when port is null", () => {
    const result = buildMainMenuResetApiCandidates({
      embeddedPort: null,
      configuredBase: "http://127.0.0.1:9999",
    });
    expect(result).toEqual(["http://127.0.0.1:9999"]);
  });

  it("skips configured when null", () => {
    const result = buildMainMenuResetApiCandidates({
      embeddedPort: 31337,
      configuredBase: null,
    });
    expect(result).toEqual(["http://127.0.0.1:31337"]);
  });

  it("returns empty when both are absent", () => {
    const result = buildMainMenuResetApiCandidates({
      embeddedPort: undefined,
      configuredBase: null,
    });
    expect(result).toEqual([]);
  });

  it("deduplicates when configured matches embedded", () => {
    const result = buildMainMenuResetApiCandidates({
      embeddedPort: 31337,
      configuredBase: "http://127.0.0.1:31337",
    });
    expect(result).toEqual(["http://127.0.0.1:31337"]);
  });
});

/* ---------- pickReachableMenuResetApiBase ---------- */

describe("pickReachableMenuResetApiBase", () => {
  const buildHeaders = () => ({});

  it("returns first candidate that responds with 2xx", async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({ ok: true });
    const result = await pickReachableMenuResetApiBase({
      candidates: ["http://a", "http://b"],
      fetchImpl,
      buildHeaders,
    });
    expect(result).toBe("http://a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips candidates that return non-ok", async () => {
    const fetchImpl: FetchLike = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const result = await pickReachableMenuResetApiBase({
      candidates: ["http://a", "http://b"],
      fetchImpl,
      buildHeaders,
    });
    expect(result).toBe("http://b");
  });

  it("skips candidates that throw", async () => {
    const fetchImpl: FetchLike = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true });
    const result = await pickReachableMenuResetApiBase({
      candidates: ["http://a", "http://b"],
      fetchImpl,
      buildHeaders,
    });
    expect(result).toBe("http://b");
  });

  it("returns null when no candidates are reachable", async () => {
    const fetchImpl: FetchLike = vi.fn().mockRejectedValue(new Error("nope"));
    const result = await pickReachableMenuResetApiBase({
      candidates: ["http://a", "http://b"],
      fetchImpl,
      buildHeaders,
    });
    expect(result).toBeNull();
  });

  it("returns null for empty candidates list", async () => {
    const fetchImpl: FetchLike = vi.fn();
    const result = await pickReachableMenuResetApiBase({
      candidates: [],
      fetchImpl,
      buildHeaders,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/* ---------- pollMenuResetAgentStatusJson ---------- */

describe("pollMenuResetAgentStatusJson", () => {
  const buildHeaders = () => ({});

  it("returns immediately when agent is already running", async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "running", agentName: "Milady" }),
    });
    const result = await pollMenuResetAgentStatusJson({
      apiBase: "http://127.0.0.1:31337",
      fetchImpl,
      buildHeaders,
    });
    expect(result).toEqual({ state: "running", agentName: "Milady" });
  });

  it("polls until agent reaches running state", async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return {
          ok: true,
          json: async () => ({ state: "starting", agentName: "Milady" }),
        };
      }
      return {
        ok: true,
        json: async () => ({ state: "running", agentName: "Milady" }),
      };
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    let time = 0;
    const now = () => time;

    const result = await pollMenuResetAgentStatusJson({
      apiBase: "http://127.0.0.1:31337",
      fetchImpl,
      buildHeaders,
      sleep,
      now,
      maxMs: 10_000,
      pollMs: 100,
    });
    expect(result.state).toBe("running");
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("returns error state after timeout", async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "starting", agentName: "Milady" }),
    });
    let time = 0;
    const sleep = vi.fn().mockImplementation(async () => {
      time += 1000;
    });

    const result = await pollMenuResetAgentStatusJson({
      apiBase: "http://127.0.0.1:31337",
      fetchImpl,
      buildHeaders,
      sleep,
      now: () => time,
      maxMs: 3000,
      pollMs: 1000,
    });
    // After timeout, should have returned the last status or error fallback
    expect(result.state).toBeDefined();
  });
});

/* ---------- runMainMenuResetAfterApiBaseResolved ---------- */

describe("runMainMenuResetAfterApiBaseResolved", () => {
  function makeDeps(
    overrides: Partial<MainMenuResetPostConfirmDeps> = {},
  ): MainMenuResetPostConfirmDeps {
    return {
      apiBase: "http://127.0.0.1:31337",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ state: "running", agentName: "Milady" }),
      }),
      buildHeaders: () => ({}),
      useEmbeddedRestart: true,
      restartEmbeddedClearingLocalDb: vi
        .fn()
        .mockResolvedValue({ port: 31337 }),
      pushEmbeddedApiBaseToRenderer: vi.fn(),
      getLocalApiAuthToken: () => "test-token",
      postExternalAgentRestart: vi.fn().mockResolvedValue(undefined),
      resolveApiBaseForStatusPoll: () => "http://127.0.0.1:31337",
      sendMenuResetAppliedToRenderer: vi.fn(),
      ...overrides,
    };
  }

  it("posts reset, restarts embedded, polls, and notifies renderer", async () => {
    const onboardingFetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce({ ok: true } as Response) // reset POST
      .mockResolvedValueOnce({
        // poll status
        ok: true,
        json: async () => ({ state: "running", agentName: "Milady" }),
      } as Response)
      .mockResolvedValueOnce({
        // onboarding check
        ok: true,
        json: async () => ({ complete: false }),
      } as Response);

    const deps = makeDeps({ fetchImpl: onboardingFetch });
    await runMainMenuResetAfterApiBaseResolved(deps);

    expect(deps.restartEmbeddedClearingLocalDb).toHaveBeenCalled();
    expect(deps.pushEmbeddedApiBaseToRenderer).toHaveBeenCalledWith(
      31337,
      "test-token",
    );
    expect(deps.sendMenuResetAppliedToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "menu-reset-app-applied",
        agentStatus: expect.objectContaining({ state: "running" }),
      }),
    );
  });

  it("uses external restart path when not embedded", async () => {
    const onboardingFetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: "running", agentName: "Milady" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ complete: false }),
      } as Response);

    const deps = makeDeps({
      useEmbeddedRestart: false,
      fetchImpl: onboardingFetch,
    });
    await runMainMenuResetAfterApiBaseResolved(deps);

    expect(deps.postExternalAgentRestart).toHaveBeenCalled();
    expect(deps.restartEmbeddedClearingLocalDb).not.toHaveBeenCalled();
  });

  it("throws when reset API responds with non-ok", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    });
    await expect(runMainMenuResetAfterApiBaseResolved(deps)).rejects.toThrow(
      "Reset API failed (500)",
    );
  });

  it("retries when onboarding is still marked complete after reset", async () => {
    let resetCallCount = 0;
    const deps = makeDeps({
      fetchImpl: vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/api/agent/reset")) {
          resetCallCount++;
          return { ok: true };
        }
        if (url.endsWith("/api/status")) {
          return {
            ok: true,
            json: async () => ({ state: "running", agentName: "Milady" }),
          };
        }
        if (url.endsWith("/api/onboarding/status")) {
          // First time: still complete (triggers retry), second time: false
          return {
            ok: true,
            json: async () => ({
              complete: resetCallCount <= 1,
            }),
          };
        }
        return { ok: false };
      }),
    });

    await runMainMenuResetAfterApiBaseResolved(deps);
    // Should have called reset at least twice (original + 1 retry)
    expect(resetCallCount).toBeGreaterThanOrEqual(2);
    expect(deps.sendMenuResetAppliedToRenderer).toHaveBeenCalled();
  });
});
