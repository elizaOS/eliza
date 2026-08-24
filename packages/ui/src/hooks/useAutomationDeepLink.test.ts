/**
 * Verifies useAutomationDeepLink — the automations feed's hash router.
 * Covers the parse/format pair's branch behaviour and the hook's real
 * location-hash sync: mount-time read, setLink writes, hashchange-driven
 * back/forward navigation, and listener teardown on unmount.
 */
// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatAutomationHash,
  parseAutomationHash,
  useAutomationDeepLink,
} from "./useAutomationDeepLink";

beforeEach(() => {
  window.history.replaceState(null, "", "http://localhost/");
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "http://localhost/");
});

describe("parseAutomationHash", () => {
  it("maps non-matching hashes to the list view", () => {
    expect(parseAutomationHash("")).toEqual({ kind: "list" });
    expect(parseAutomationHash("#settings")).toEqual({ kind: "list" });
    // Shorter than the prefix: startsWith must not match a partial name.
    expect(parseAutomationHash("#automation")).toEqual({ kind: "list" });
  });

  it("maps the bare feed hash to the list view", () => {
    expect(parseAutomationHash("#automations")).toEqual({ kind: "list" });
  });

  it("maps the trailing-slash-only hash to the list view", () => {
    expect(parseAutomationHash("#automations/")).toEqual({ kind: "list" });
  });

  it("rejects an empty task id", () => {
    expect(parseAutomationHash("#automations/task/")).toEqual({
      kind: "list",
    });
  });

  it("parses a workflow deep link", () => {
    expect(parseAutomationHash("#automations/wf-123")).toEqual({
      kind: "workflow",
      id: "wf-123",
    });
  });

  it("parses a task deep link", () => {
    expect(parseAutomationHash("#automations/task/t-9")).toEqual({
      kind: "task",
      id: "t-9",
    });
  });

  it("keeps slashes inside ids so composite ids survive parsing", () => {
    expect(parseAutomationHash("#automations/a/b/c")).toEqual({
      kind: "workflow",
      id: "a/b/c",
    });
    expect(parseAutomationHash("#automations/task/a/b")).toEqual({
      kind: "task",
      id: "a/b",
    });
  });
});

describe("formatAutomationHash", () => {
  it("formats each link kind to its canonical hash", () => {
    expect(formatAutomationHash({ kind: "list" })).toBe("#automations");
    expect(formatAutomationHash({ kind: "workflow", id: "wf-1" })).toBe(
      "#automations/wf-1",
    );
    expect(formatAutomationHash({ kind: "task", id: "t-1" })).toBe(
      "#automations/task/t-1",
    );
  });

  it("round-trips every link kind losslessly through parse", () => {
    const links = [
      { kind: "list" },
      { kind: "workflow", id: "wf 42" },
      { kind: "task", id: "task/../id" },
    ] as const;
    for (const link of links) {
      expect(parseAutomationHash(formatAutomationHash(link))).toEqual(link);
    }
  });
});

describe("useAutomationDeepLink", () => {
  it("starts on the list view when no hash is present", () => {
    const { result } = renderHook(() => useAutomationDeepLink());

    expect(result.current.link).toEqual({ kind: "list" });
  });

  it("reads the deep link present at mount time", () => {
    window.location.hash = "#automations/task/mounted-task";

    const { result } = renderHook(() => useAutomationDeepLink());

    expect(result.current.link).toEqual({ kind: "task", id: "mounted-task" });
  });

  it("setLink updates state and mirrors the canonical hash into the URL", async () => {
    const { result } = renderHook(() => useAutomationDeepLink());

    act(() => {
      result.current.setLink({ kind: "workflow", id: "wf-open" });
    });

    expect(result.current.link).toEqual({ kind: "workflow", id: "wf-open" });
    await waitFor(() => {
      expect(window.location.hash).toBe("#automations/wf-open");
    });
  });

  it("returning to the list rewrites the hash back to the feed root", async () => {
    window.location.hash = "#automations/task/t-1";
    const { result } = renderHook(() => useAutomationDeepLink());

    act(() => {
      result.current.setLink({ kind: "list" });
    });

    expect(result.current.link).toEqual({ kind: "list" });
    await waitFor(() => {
      expect(window.location.hash).toBe("#automations");
    });
  });

  it("follows browser back/forward navigation via hashchange", async () => {
    const { result } = renderHook(() => useAutomationDeepLink());
    expect(result.current.link).toEqual({ kind: "list" });

    act(() => {
      window.location.hash = "#automations/task/nav-task";
    });
    await waitFor(() => {
      expect(result.current.link).toEqual({ kind: "task", id: "nav-task" });
    });

    act(() => {
      window.location.hash = "#automations/back-wf";
    });
    await waitFor(() => {
      expect(result.current.link).toEqual({
        kind: "workflow",
        id: "back-wf",
      });
    });
  });

  it("stops following hash changes after unmount", async () => {
    const { result, unmount } = renderHook(() => useAutomationDeepLink());
    act(() => {
      result.current.setLink({ kind: "workflow", id: "wf-live" });
    });
    await waitFor(() => {
      expect(window.location.hash).toBe("#automations/wf-live");
    });

    unmount();
    // Fire the exact DOM event browsers emit on back/forward so this holds
    // regardless of whether jsdom auto-fires one for the assignment itself.
    act(() => {
      window.location.hash = "#automations/task/after-unmount";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.link).toEqual({ kind: "workflow", id: "wf-live" });
  });
});
