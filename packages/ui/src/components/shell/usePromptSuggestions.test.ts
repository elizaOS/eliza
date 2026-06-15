// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShellMessage } from "./shell-state";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../api/client", () => ({ client: { fetch: fetchMock } }));

import {
  computePromptSuggestions,
  pageScopeFromLocation,
  usePromptSuggestions,
} from "./usePromptSuggestions";

const msg = (id: string, role: ShellMessage["role"], content: string) =>
  ({ id, role, content, createdAt: 0 }) as ShellMessage;

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
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

  it("sends the active page scope so the server can tailor per view (#8225)", async () => {
    fetchMock.mockResolvedValue({ suggestions: ["A", "B", "C"] });
    renderHook(() =>
      usePromptSuggestions([], { enabled: true, scope: "page-lifeops" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.scope).toBe("page-lifeops");
  });
});

describe("pageScopeFromLocation", () => {
  it("derives the scope from a path segment", () => {
    expect(pageScopeFromLocation("/lifeops", "")).toBe("page-lifeops");
    expect(pageScopeFromLocation("/wallet/send", "")).toBe("page-wallet");
  });

  it("prefers the hash segment when present (hash navigation)", () => {
    expect(pageScopeFromLocation("/", "#/settings?x=1")).toBe("page-settings");
    expect(pageScopeFromLocation("/lifeops", "#/apps")).toBe("page-apps");
  });

  it("returns undefined for unscoped or empty views", () => {
    expect(pageScopeFromLocation("/", "")).toBeUndefined();
    expect(pageScopeFromLocation("/chat", "")).toBeUndefined();
    expect(pageScopeFromLocation("/not-a-real-tab", "")).toBeUndefined();
  });
});
