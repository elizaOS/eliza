// @vitest-environment jsdom
//
// The prompt-suggestion strip: the pure computePromptSuggestions fallback (always
// 3, deduped, daypart-/page-aware) plus the usePromptSuggestions hook that fetches
// model suggestions. The API client is mocked, so the hook exercises the static
// fallback path in jsdom.

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShellMessage } from "./shell-state";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../api/client", () => ({ client: { fetch: fetchMock } }));

import {
  computePromptSuggestions,
  daypartForHour,
  pageScopeFromLocation,
  resetPromptSuggestionMemory,
  usePromptSuggestions,
} from "./usePromptSuggestions";

const msg = (id: string, role: ShellMessage["role"], content: string) =>
  ({ id, role, content, createdAt: 0 }) as ShellMessage;

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  resetPromptSuggestionMemory();
});

describe("computePromptSuggestions", () => {
  it("returns exactly 3 suggestions for an empty thread", () => {
    const out = computePromptSuggestions([]);
    expect(out).toHaveLength(3);
  });

  it("returns unique (deduped) suggestions", () => {
    const out = computePromptSuggestions([]);
    expect(new Set(out).size).toBe(out.length);
  });

  it("leads with the neutral starter when there is no thread and no clock", () => {
    const out = computePromptSuggestions([
      msg("a", "user", "   "), // whitespace-only does not count as a thread
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("What can you do?");
  });

  it("tailors the cold-start lead to the time of day", () => {
    expect(computePromptSuggestions([], 8)[0]).toBe("Plan my day"); // morning
    expect(computePromptSuggestions([], 14)[0]).toBe("What's left today?"); // afternoon
    expect(computePromptSuggestions([], 21)[0]).toBe("Recap my day"); // evening
    expect(computePromptSuggestions([], 3)[0]).toBe("Recap my day"); // late night
    // still exactly 3 unique regardless of the hour
    for (const h of [8, 14, 21, 3]) {
      const out = computePromptSuggestions([], h);
      expect(out).toHaveLength(3);
      expect(new Set(out).size).toBe(3);
    }
  });

  it("history beats time of day: an active thread always leads with the follow-up", () => {
    const thread = [msg("a", "user", "hi"), msg("b", "assistant", "hey there")];
    for (const h of [8, 14, 21, undefined]) {
      const out = computePromptSuggestions(thread, h);
      expect(out).toHaveLength(3);
      expect(out[0]).toBe("Continue where we left off");
      expect(new Set(out).size).toBe(3);
    }
  });
});

describe("usePromptSuggestions (model-backed)", () => {
  it("yields the static fallback and does NOT hit the endpoint while disabled", () => {
    fetchMock.mockResolvedValue({ suggestions: ["A", "B", "C"] });
    const { result } = renderHook(() =>
      usePromptSuggestions([], { enabled: false }),
    );
    expect(result.current).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upgrades to the model suggestions once the endpoint resolves", async () => {
    const model = ["Check my calendar", "Reply to Sam", "Summarize the thread"];
    fetchMock.mockResolvedValue({ suggestions: model });
    const { result } = renderHook(() =>
      usePromptSuggestions([], { enabled: true }),
    );
    // Immediate value is the static fallback, not the (async) model set.
    expect(result.current).toHaveLength(3);
    expect(result.current).not.toEqual(model);
    await waitFor(() => expect(result.current).toEqual(model));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/suggestions",
      expect.objectContaining({ method: "POST" }),
      expect.any(Object),
    );
  });

  it("keeps the static fallback when the endpoint fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() =>
      usePromptSuggestions([], { enabled: true }),
    );
    const fallback = [...result.current];
    expect(fallback).toHaveLength(3);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toEqual(fallback);
  });

  it("ignores a short model set (fewer than 3) and stays on the fallback", async () => {
    fetchMock.mockResolvedValue({ suggestions: ["only one"] });
    const { result } = renderHook(() =>
      usePromptSuggestions([], { enabled: true }),
    );
    const fallback = [...result.current];
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toEqual(fallback);
  });

  it("is stable across overlay open/close: a remount reuses the remembered set without refetching", async () => {
    const model = ["Check my calendar", "Reply to Sam", "Summarize the thread"];
    fetchMock.mockResolvedValue({ suggestions: model });
    const thread = [msg("a", "user", "hi"), msg("b", "assistant", "hey")];

    const first = renderHook(() =>
      usePromptSuggestions(thread, { enabled: true }),
    );
    await waitFor(() => expect(first.result.current).toEqual(model));
    first.unmount();

    // Same conversation, new mount (user closed and reopened the overlay).
    const second = renderHook(() =>
      usePromptSuggestions(thread, { enabled: true }),
    );
    // The remembered set is there synchronously — no fallback flash, no re-roll.
    expect(second.result.current).toEqual(model);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-rolls when the conversation advances (new last message)", async () => {
    fetchMock.mockResolvedValueOnce({ suggestions: ["A1", "A2", "A3"] });
    const thread = [msg("a", "user", "hi")];
    const first = renderHook(() =>
      usePromptSuggestions(thread, { enabled: true }),
    );
    await waitFor(() =>
      expect(first.result.current).toEqual(["A1", "A2", "A3"]),
    );
    first.unmount();

    fetchMock.mockResolvedValueOnce({ suggestions: ["B1", "B2", "B3"] });
    const grown = [...thread, msg("b", "assistant", "hey there")];
    const second = renderHook(() =>
      usePromptSuggestions(grown, { enabled: true }),
    );
    await waitFor(() =>
      expect(second.result.current).toEqual(["B1", "B2", "B3"]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the active page scope so the server can tailor per view (#8225)", async () => {
    fetchMock.mockResolvedValue({ suggestions: ["A", "B", "C"] });
    renderHook(() =>
      usePromptSuggestions([], { enabled: true, scope: "page-wallet" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.scope).toBe("page-wallet");
  });

  it("does not surface or remember heuristic-tier responses (retries on a later reveal)", async () => {
    fetchMock.mockResolvedValueOnce({
      suggestions: ["H1", "H2", "H3"],
      tier: "heuristic",
    });
    const first = renderHook(() => usePromptSuggestions([], { enabled: true }));
    const fallback = [...first.result.current];
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Heuristic filler is ignored; the deterministic fallback keeps showing.
    expect(first.result.current).toEqual(fallback);
    first.unmount();

    // Next reveal retries and the real model set wins.
    const model = ["Check my calendar", "Reply to Sam", "Summarize the thread"];
    fetchMock.mockResolvedValueOnce({ suggestions: model, tier: "model" });
    const second = renderHook(() =>
      usePromptSuggestions([], { enabled: true }),
    );
    await waitFor(() => expect(second.result.current).toEqual(model));
  });

  it("banks a response that lands after the strip closes — the next reveal reuses it without refetching", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const model = ["Check my calendar", "Reply to Sam", "Summarize the thread"];

    const first = renderHook(() => usePromptSuggestions([], { enabled: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // User closes the strip before the model responds.
    first.unmount();
    resolveFetch({ suggestions: model, tier: "model" });
    // Let the in-flight promise settle into the cache.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const second = renderHook(() =>
      usePromptSuggestions([], { enabled: true }),
    );
    await waitFor(() => expect(second.result.current).toEqual(model));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent consumers of the same context onto one request", async () => {
    const model = ["Check my calendar", "Reply to Sam", "Summarize the thread"];
    fetchMock.mockResolvedValue({ suggestions: model, tier: "model" });
    const a = renderHook(() => usePromptSuggestions([], { enabled: true }));
    const b = renderHook(() => usePromptSuggestions([], { enabled: true }));
    await waitFor(() => expect(a.result.current).toEqual(model));
    await waitFor(() => expect(b.result.current).toEqual(model));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never shows a previous context's model set on a cold key (falls back deterministically)", async () => {
    fetchMock.mockResolvedValueOnce({
      suggestions: ["A1", "A2", "A3"],
      tier: "model",
    });
    const thread = [msg("a", "user", "hi")];
    const { result, rerender } = renderHook(
      ({ messages }: { messages: ShellMessage[] }) =>
        usePromptSuggestions(messages, { enabled: true }),
      { initialProps: { messages: thread } },
    );
    await waitFor(() => expect(result.current).toEqual(["A1", "A2", "A3"]));

    // The conversation advances while the hook stays mounted (overlay never
    // unmounts): the cold key must NOT bleed the old set while refetching.
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const grown = [...thread, msg("b", "assistant", "hey there")];
    rerender({ messages: grown });
    expect(result.current).toEqual(computePromptSuggestions(grown));
    expect(result.current).not.toEqual(["A1", "A2", "A3"]);
    resolveFetch({ suggestions: ["B1", "B2", "B3"], tier: "model" });
    await waitFor(() => expect(result.current).toEqual(["B1", "B2", "B3"]));
  });
});

describe("daypartForHour", () => {
  it("matches the timeOfDayLead boundaries", () => {
    expect(daypartForHour(5)).toBe("morning");
    expect(daypartForHour(11)).toBe("morning");
    expect(daypartForHour(12)).toBe("afternoon");
    expect(daypartForHour(17)).toBe("afternoon");
    expect(daypartForHour(18)).toBe("evening");
    expect(daypartForHour(23)).toBe("evening");
    expect(daypartForHour(0)).toBe("evening");
    expect(daypartForHour(4)).toBe("evening");
  });
});

describe("pageScopeFromLocation", () => {
  it("derives the scope from a path segment", () => {
    expect(pageScopeFromLocation("/browser", "")).toBe("page-browser");
    expect(pageScopeFromLocation("/wallet/send", "")).toBe("page-wallet");
  });

  it("prefers the hash segment when present (hash navigation)", () => {
    expect(pageScopeFromLocation("/", "#/settings?x=1")).toBe("page-settings");
    expect(pageScopeFromLocation("/browser", "#/apps")).toBe("page-apps");
  });

  it("returns undefined for unscoped or empty views", () => {
    expect(pageScopeFromLocation("/", "")).toBeUndefined();
    expect(pageScopeFromLocation("/chat", "")).toBeUndefined();
    expect(pageScopeFromLocation("/not-a-real-tab", "")).toBeUndefined();
  });
});
