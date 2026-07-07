// @vitest-environment jsdom
//
// Drives the real per-tab native-surface hook against a faithful in-memory
// NativeSurfaceShell that records the exact command sequence (#15245). Proves
// every surface is created with an EXPLICIT process/storage policy, that
// selection/overlay changes foreground/background the right surfaces, that a
// layout shift re-measures bounds, that closing a tab destroys its surface, and
// — the manifest-driven red→green — that the unmount teardown follows the
// declared lifecycle (retained → background-warm, ephemeral → destroy).

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  NativeSurfaceCreateRequest,
  NativeSurfacePolicy,
  NativeSurfaceShell,
  SurfaceBounds,
} from "./native-surface-shell";
import {
  type MobileNativeSurfaceTab,
  useMobileNativeTabSurfaces,
} from "./use-mobile-native-tab-surfaces";

class RecordingShell implements NativeSurfaceShell {
  readonly commands: string[] = [];
  readonly created = new Map<string, NativeSurfaceCreateRequest>();
  readonly bounds = new Map<string, SurfaceBounds>();
  readonly navigations: Array<{ id: string; url: string }> = [];
  private readonly live = new Set<string>();

  createSurface(req: NativeSurfaceCreateRequest): void {
    this.commands.push(`create:${req.id}`);
    this.created.set(req.id, req);
    this.live.add(req.id);
  }
  setBounds(id: string, bounds: SurfaceBounds): void {
    this.commands.push(`bounds:${id}`);
    this.bounds.set(id, bounds);
  }
  navigate(id: string, url: string): void {
    this.commands.push(`navigate:${id}`);
    this.navigations.push({ id, url });
  }
  foregroundSurface(id: string): void {
    this.commands.push(`fg:${id}`);
  }
  backgroundSurface(id: string): void {
    this.commands.push(`bg:${id}`);
  }
  destroySurface(id: string): void {
    this.commands.push(`destroy:${id}`);
    this.live.delete(id);
  }
  foregroundHost(): void {
    this.commands.push("fg:host");
  }
  hasSurface(id: string): boolean {
    return this.live.has(id);
  }
}

const ISOLATED: NativeSurfacePolicy = {
  process: "isolated",
  storage: "isolated",
};

function tab(
  id: string,
  url = `https://${id}.example`,
): MobileNativeSurfaceTab {
  return { id, url };
}

function elementAt(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      x: rect.x ?? 0,
      y: rect.y ?? 0,
      left: rect.left ?? rect.x ?? 0,
      top: rect.top ?? rect.y ?? 0,
      right: 0,
      bottom: 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useMobileNativeTabSurfaces", () => {
  const base = {
    active: true as boolean,
    tabs: [tab("a")] as readonly MobileNativeSurfaceTab[],
    selectedTabId: "a" as string | null,
    overlayOpen: false,
    policy: ISOLATED,
    lifecycle: "ephemeral" as const,
  };

  it("creates each surface with an explicit process AND storage policy", () => {
    const shell = new RecordingShell();
    renderHook(() => useMobileNativeTabSurfaces({ ...base, shell }));

    expect(shell.commands).toContain("create:browser-tab:a");
    expect(shell.commands).toContain("fg:browser-tab:a");
    // The explicit policy — never an implicit default — is what the shell got.
    expect(shell.created.get("browser-tab:a")?.policy).toEqual(ISOLATED);
    expect(shell.created.get("browser-tab:a")?.url).toBe("https://a.example");
  });

  it("does nothing while inactive (not on the native-mobile-webview path)", () => {
    const shell = new RecordingShell();
    renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, active: false, shell }),
    );
    expect(shell.commands).toEqual([]);
  });

  it("measures the placeholder rect on register and re-measures on a layout shift", () => {
    const shell = new RecordingShell();
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );

    act(() => {
      result.current.registerSurfaceElement(
        "a",
        elementAt({ left: 12, top: 34, width: 300, height: 500 }),
      );
    });
    expect(shell.bounds.get("browser-tab:a")).toEqual({
      x: 12,
      y: 34,
      width: 300,
      height: 500,
    });

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    // Still tracking after the layout shift (a fresh setBounds command fired).
    expect(
      shell.commands.filter((c) => c === "bounds:browser-tab:a").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("foregrounds the selected surface and backgrounds the rest on tab switch", () => {
    const shell = new RecordingShell();
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: base },
    );

    rerender({ ...base, tabs: [tab("a"), tab("b")], selectedTabId: "b" });

    expect(shell.commands).toContain("create:browser-tab:b");
    const tail = shell.commands.slice(
      shell.commands.indexOf("create:browser-tab:b"),
    );
    expect(tail).toContain("fg:browser-tab:b");
    expect(tail).toContain("bg:browser-tab:a");
  });

  it("backgrounds every surface while an overlay is open, restoring on close", () => {
    const shell = new RecordingShell();
    const twoTabs = { ...base, tabs: [tab("a"), tab("b")], selectedTabId: "b" };
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: twoTabs },
    );

    shell.commands.length = 0;
    rerender({ ...twoTabs, overlayOpen: true });
    expect(shell.commands).toContain("bg:browser-tab:a");
    expect(shell.commands).toContain("bg:browser-tab:b");
    expect(shell.commands).not.toContain("fg:browser-tab:b");

    shell.commands.length = 0;
    rerender({ ...twoTabs, overlayOpen: false });
    expect(shell.commands).toContain("fg:browser-tab:b");
    expect(shell.commands).toContain("bg:browser-tab:a");
  });

  it("navigates the tab's surface without recreating it", () => {
    const shell = new RecordingShell();
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    act(() => result.current.navigateSurface("a", "https://a2.example"));
    expect(shell.navigations).toEqual([
      { id: "browser-tab:a", url: "https://a2.example" },
    ]);
    expect(
      shell.commands.filter((c) => c === "create:browser-tab:a"),
    ).toHaveLength(1);
  });

  it("navigates a surface declaratively when a tab's url changes, without recreating it", () => {
    const shell = new RecordingShell();
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: base },
    );
    shell.commands.length = 0;
    rerender({ ...base, tabs: [tab("a", "https://a-new.example")] });
    expect(shell.navigations).toContainEqual({
      id: "browser-tab:a",
      url: "https://a-new.example",
    });
    expect(
      shell.commands.filter((c) => c === "create:browser-tab:a"),
    ).toHaveLength(0);
  });

  it("destroys a surface when its tab is closed", () => {
    const shell = new RecordingShell();
    const twoTabs = { ...base, tabs: [tab("a"), tab("b")], selectedTabId: "a" };
    const { rerender } = renderHook(
      (props: typeof base) => useMobileNativeTabSurfaces({ ...props, shell }),
      { initialProps: twoTabs },
    );
    rerender({ ...twoTabs, tabs: [tab("a")], selectedTabId: "a" });
    expect(shell.commands).toContain("destroy:browser-tab:b");
    expect(shell.hasSurface("browser-tab:b")).toBe(false);
    expect(shell.hasSurface("browser-tab:a")).toBe(true);
  });

  it("destroys all surfaces on unmount when lifecycle is ephemeral", () => {
    const shell = new RecordingShell();
    const { unmount } = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        tabs: [tab("a"), tab("b")],
        lifecycle: "ephemeral",
        shell,
      }),
    );
    shell.commands.length = 0;
    unmount();
    expect(shell.commands).toContain("destroy:browser-tab:a");
    expect(shell.commands).toContain("destroy:browser-tab:b");
  });

  it("keeps surfaces warm (background) on unmount when lifecycle is retained — red→green on the manifest", () => {
    const shell = new RecordingShell();
    const { unmount } = renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        tabs: [tab("a"), tab("b")],
        lifecycle: "retained",
        shell,
      }),
    );
    shell.commands.length = 0;
    unmount();
    expect(shell.commands).toContain("bg:browser-tab:a");
    expect(shell.commands).toContain("bg:browser-tab:b");
    expect(shell.commands).not.toContain("destroy:browser-tab:a");
    expect(shell.commands).not.toContain("destroy:browser-tab:b");
  });
});
