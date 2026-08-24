/**
 * Verifies the promise-returning useConfirm/usePrompt wrappers: modalProps
 * starts closed and inert, opens with the caller's options, resolves through
 * onConfirm/onCancel, closes after each resolution, supports sequential and
 * superseding calls, and keeps stable callback identities.
 */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useConfirm, usePrompt } from "./confirm-dialog.hooks";

afterEach(() => {
  cleanup();
});

describe("useConfirm", () => {
  it("starts closed with a blank message and inert no-op handlers", () => {
    const { result } = renderHook(() => useConfirm());

    expect(result.current.modalProps.open).toBe(false);
    expect(result.current.modalProps.message).toBe("");
    expect(typeof result.current.modalProps.onConfirm).toBe("function");
    expect(typeof result.current.modalProps.onCancel).toBe("function");

    expect(() => {
      result.current.modalProps.onConfirm();
      result.current.modalProps.onCancel();
    }).not.toThrow();
    expect(result.current.modalProps.open).toBe(false);
  });

  it("opens with every caller option spread onto modalProps", () => {
    const { result } = renderHook(() => useConfirm());

    act(() => {
      result.current.confirm({
        title: "Delete agent?",
        message: "This cannot be undone.",
        confirmLabel: "Delete",
        cancelLabel: "Keep",
        variant: "danger",
      });
    });

    expect(result.current.modalProps).toMatchObject({
      open: true,
      title: "Delete agent?",
      message: "This cannot be undone.",
      confirmLabel: "Delete",
      cancelLabel: "Keep",
      variant: "danger",
    });
  });

  it("passes only the given options through and leaves absent options undefined", () => {
    const { result } = renderHook(() => useConfirm());

    act(() => {
      result.current.confirm({ message: "Proceed?" });
    });

    expect(result.current.modalProps.open).toBe(true);
    expect(result.current.modalProps.message).toBe("Proceed?");
    expect(result.current.modalProps.title).toBeUndefined();
    expect(result.current.modalProps.confirmLabel).toBeUndefined();
    expect(result.current.modalProps.cancelLabel).toBeUndefined();
    expect(result.current.modalProps.variant).toBeUndefined();
  });

  it("resolves true and closes when onConfirm fires", async () => {
    const { result } = renderHook(() => useConfirm());
    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.confirm({ message: "Proceed?" });
    });
    expect(result.current.modalProps.open).toBe(true);

    await act(async () => {
      result.current.modalProps.onConfirm();
    });

    await expect(promise).resolves.toBe(true);
    expect(result.current.modalProps.open).toBe(false);
    expect(result.current.modalProps.message).toBe("");
  });

  it("resolves false and closes when onCancel fires", async () => {
    const { result } = renderHook(() => useConfirm());
    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.confirm({ message: "Proceed?" });
    });

    await act(async () => {
      result.current.modalProps.onCancel();
    });

    await expect(promise).resolves.toBe(false);
    expect(result.current.modalProps.open).toBe(false);
  });

  it("supports a fresh dialog after the previous one resolved", async () => {
    const { result } = renderHook(() => useConfirm());
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.confirm({ message: "First?" });
    });
    await act(async () => {
      result.current.modalProps.onConfirm();
    });
    await expect(first).resolves.toBe(true);

    let second!: Promise<boolean>;
    act(() => {
      second = result.current.confirm({
        message: "Second?",
        variant: "warn",
      });
    });
    expect(result.current.modalProps.open).toBe(true);
    expect(result.current.modalProps.message).toBe("Second?");
    expect(result.current.modalProps.variant).toBe("warn");

    await act(async () => {
      result.current.modalProps.onCancel();
    });
    await expect(second).resolves.toBe(false);
    expect(result.current.modalProps.open).toBe(false);
  });

  it("replaces an unanswered dialog when confirm is called again, leaving the stale promise pending", async () => {
    const { result } = renderHook(() => useConfirm());
    let stale!: Promise<boolean>;
    act(() => {
      stale = result.current.confirm({ message: "Stale?" });
    });
    let live!: Promise<boolean>;
    act(() => {
      live = result.current.confirm({ message: "Live?" });
    });

    expect(result.current.modalProps.message).toBe("Live?");

    await act(async () => {
      result.current.modalProps.onConfirm();
    });
    await expect(live).resolves.toBe(true);

    const outcome = await Promise.race([stale, Promise.resolve("pending")]);
    expect(outcome).toBe("pending");
  });

  it("returns a stable confirm identity across rerenders", () => {
    const { result, rerender } = renderHook(() => useConfirm());
    const original = result.current.confirm;

    rerender();

    expect(result.current.confirm).toBe(original);
  });
});

describe("usePrompt", () => {
  it("starts closed with a blank message and inert no-op handlers", () => {
    const { result } = renderHook(() => usePrompt());

    expect(result.current.modalProps.open).toBe(false);
    expect(result.current.modalProps.message).toBe("");
    expect(typeof result.current.modalProps.onConfirm).toBe("function");
    expect(typeof result.current.modalProps.onCancel).toBe("function");

    expect(() => {
      result.current.modalProps.onConfirm("");
      result.current.modalProps.onCancel();
    }).not.toThrow();
    expect(result.current.modalProps.open).toBe(false);
  });

  it("opens with every caller option spread onto modalProps", () => {
    const { result } = renderHook(() => usePrompt());

    act(() => {
      result.current.prompt({
        title: "Rename agent",
        message: "Enter the new name.",
        placeholder: "My agent",
        defaultValue: "Old name",
        confirmLabel: "Save",
        cancelLabel: "Discard",
      });
    });

    expect(result.current.modalProps).toMatchObject({
      open: true,
      title: "Rename agent",
      message: "Enter the new name.",
      placeholder: "My agent",
      defaultValue: "Old name",
      confirmLabel: "Save",
      cancelLabel: "Discard",
    });
  });

  it("resolves the submitted value and closes when onConfirm fires", async () => {
    const { result } = renderHook(() => usePrompt());
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.prompt({
        message: "Enter value",
        defaultValue: "draft",
      });
    });

    await act(async () => {
      result.current.modalProps.onConfirm("submitted text");
    });

    await expect(promise).resolves.toBe("submitted text");
    expect(result.current.modalProps.open).toBe(false);
  });

  it("distinguishes an empty-string submission from cancellation", async () => {
    const { result } = renderHook(() => usePrompt());
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.prompt({ message: "Optional note" });
    });

    await act(async () => {
      result.current.modalProps.onConfirm("");
    });

    await expect(promise).resolves.toBe("");
  });

  it("resolves null and closes when onCancel fires", async () => {
    const { result } = renderHook(() => usePrompt());
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.prompt({ message: "Enter value" });
    });

    await act(async () => {
      result.current.modalProps.onCancel();
    });

    await expect(promise).resolves.toBeNull();
    expect(result.current.modalProps.open).toBe(false);
  });

  it("supports a fresh prompt after the previous one resolved", async () => {
    const { result } = renderHook(() => usePrompt());
    let first!: Promise<string | null>;
    act(() => {
      first = result.current.prompt({ message: "First?", placeholder: "a" });
    });
    await act(async () => {
      result.current.modalProps.onConfirm("one");
    });
    await expect(first).resolves.toBe("one");

    let second!: Promise<string | null>;
    act(() => {
      second = result.current.prompt({
        message: "Second?",
        defaultValue: "two-default",
      });
    });
    expect(result.current.modalProps.open).toBe(true);
    expect(result.current.modalProps.message).toBe("Second?");
    expect(result.current.modalProps.defaultValue).toBe("two-default");

    await act(async () => {
      result.current.modalProps.onCancel();
    });
    await expect(second).resolves.toBeNull();
    expect(result.current.modalProps.open).toBe(false);
  });

  it("replaces an unanswered prompt when prompt is called again, leaving the stale promise pending", async () => {
    const { result } = renderHook(() => usePrompt());
    let stale!: Promise<string | null>;
    act(() => {
      stale = result.current.prompt({ message: "Stale?" });
    });
    let live!: Promise<string | null>;
    act(() => {
      live = result.current.prompt({ message: "Live?" });
    });

    expect(result.current.modalProps.message).toBe("Live?");

    await act(async () => {
      result.current.modalProps.onConfirm("chosen");
    });
    await expect(live).resolves.toBe("chosen");

    const outcome = await Promise.race([stale, Promise.resolve("pending")]);
    expect(outcome).toBe("pending");
  });

  it("returns a stable prompt identity across rerenders", () => {
    const { result, rerender } = renderHook(() => usePrompt());
    const original = result.current.prompt;

    rerender();

    expect(result.current.prompt).toBe(original);
  });
});
