// @vitest-environment jsdom
/**
 * fetchServerFavoriteApps startup gating (iOS boot-warning D2 item 3).
 *
 * During iOS boot the local-agent transport can be legitimately mode-gated
 * (cloud builds reject local-agent IPC until runtime-mode reconciliation
 * settles). That expected phase must NOT produce
 * "[persistence] failed to fetch server favorite apps: …" warnings — it logs
 * at debug level and `useAppShellState` retries once after agent-ready.
 * Genuine failures (network down, server bug) still warn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.fn();
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
}));

const warn = vi.fn();
const debug = vi.fn();
vi.mock("@elizaos/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/logger")>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      warn: (...args: unknown[]) => warn(...args),
      debug: (...args: unknown[]) => debug(...args),
    },
  };
});

import { fetchServerFavoriteApps } from "./persistence";

const IPC_POLICY_MESSAGE =
  "iOS cloud builds cannot use local-agent IPC unless local runtime mode is active";

beforeEach(() => {
  fetchWithCsrf.mockReset();
  warn.mockReset();
  debug.mockReset();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("fetchServerFavoriteApps startup transport gating", () => {
  it("logs debug (not warn) when the transport is mode-gated during boot", async () => {
    fetchWithCsrf.mockRejectedValueOnce(new Error(IPC_POLICY_MESSAGE));

    await expect(fetchServerFavoriteApps()).resolves.toBeNull();

    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain(IPC_POLICY_MESSAGE);
    expect(String(debug.mock.calls[0]?.[0])).toContain("mode-gated");
  });

  it("classifies every terminal iOS transport policy message as debug-level", async () => {
    const terminalMessages = [
      "iOS store builds must use eliza-local-agent://ipc for local-agent requests",
      "iOS store/cloud builds block cleartext loopback or private-network requests",
      "Full Bun iOS runtime required but engine missing",
      "iOS Agent requires a configured HTTP endpoint",
    ];
    for (const message of terminalMessages) {
      fetchWithCsrf.mockRejectedValueOnce(new Error(message));
      await expect(fetchServerFavoriteApps()).resolves.toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(terminalMessages.length);
  });

  it("still warns on genuine (non-gated) fetch failures", async () => {
    fetchWithCsrf.mockRejectedValueOnce(new Error("Failed to fetch"));

    await expect(fetchServerFavoriteApps()).resolves.toBeNull();

    expect(debug).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "failed to fetch server favorite apps",
    );
    expect(String(warn.mock.calls[0]?.[0])).toContain("Failed to fetch");
  });

  it("returns null without logging when the server responds non-OK", async () => {
    fetchWithCsrf.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(fetchServerFavoriteApps()).resolves.toBeNull();

    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it("hydrates + mirrors to localStorage on success", async () => {
    fetchWithCsrf.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ favoriteApps: ["chat", "focus", "chat", 7, ""] }),
    });

    await expect(fetchServerFavoriteApps()).resolves.toEqual(["chat", "focus"]);

    expect(
      JSON.parse(localStorage.getItem("eliza:favorite-apps") ?? "[]"),
    ).toEqual(["chat", "focus"]);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });
});
