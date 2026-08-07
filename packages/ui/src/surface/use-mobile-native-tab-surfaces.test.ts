/** Verifies useMobileNativeTabSurfaces through the package's configured test harness. */
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
  SurfaceOcclusionRect,
} from "./native-surface-shell";
import {
  collectSurfaceOcclusionRects,
  collectSurfaceOuterClip,
  type MobileNativeSurfaceTab,
  useMobileNativeTabSurfaces,
} from "./use-mobile-native-tab-surfaces";

class RecordingShell implements NativeSurfaceShell {
  readonly commands: string[] = [];
  readonly created = new Map<string, NativeSurfaceCreateRequest>();
  readonly bounds = new Map<string, SurfaceBounds>();
  readonly occlusions = new Map<string, readonly SurfaceOcclusionRect[]>();
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
  setOcclusionRects(id: string, rects: readonly SurfaceOcclusionRect[]): void {
    this.commands.push(`occlusions:${id}`);
    this.occlusions.set(id, rects);
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

class DropFirstBoundsShell extends RecordingShell {
  attempts = 0;

  override setBounds(id: string, bounds: SurfaceBounds): void {
    this.attempts += 1;
    if (this.attempts === 1) {
      this.commands.push(`bounds-rejected:${id}`);
      return;
    }
    super.setBounds(id, bounds);
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

  it("reads visible rounded host geometry in CSS pixels", () => {
    const visible = elementAt({
      left: 12.04,
      top: 34.06,
      width: 300,
      height: 80,
    });
    visible.className = "overlay";
    visible.style.borderRadius = "31.96px";
    document.body.append(visible);
    const hidden = elementAt({ left: 1, top: 2, width: 3, height: 4 });
    hidden.className = "overlay";
    hidden.style.display = "none";
    document.body.append(hidden);
    const nested = elementAt({ left: 20, top: 40, width: 100, height: 40 });
    nested.className = "overlay";
    document.body.append(nested);

    expect(collectSurfaceOcclusionRects(".overlay", document)).toEqual([
      {
        x: 12,
        y: 34.1,
        width: 300,
        height: 80,
        cornerRadius: 32,
      },
    ]);
  });

  it("reads the nearest real rounded overflow host without duplicating its CSS radius", () => {
    const host = elementAt({ left: 8, top: 72, width: 368, height: 640 });
    host.style.overflow = "hidden";
    host.style.borderTopLeftRadius = "24px";
    host.style.borderTopRightRadius = "20px";
    host.style.borderBottomRightRadius = "16px";
    host.style.borderBottomLeftRadius = "12px";
    const surface = elementAt({ left: 10, top: 74, width: 364, height: 636 });
    host.append(surface);
    document.body.append(host);

    expect(collectSurfaceOuterClip(surface)).toEqual({
      x: 8,
      y: 72,
      width: 368,
      height: 640,
      cornerRadii: {
        topLeft: 24,
        topRight: 20,
        bottomRight: 16,
        bottomLeft: 12,
      },
    });
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
      outerClip: {
        x: 12,
        y: 34,
        width: 300,
        height: 500,
        cornerRadii: {
          topLeft: 0,
          topRight: 0,
          bottomRight: 0,
          bottomLeft: 0,
        },
      },
    });

    act(() => {
      const element = elementAt({ left: 13, top: 35, width: 301, height: 501 });
      result.current.registerSurfaceElement("a", element);
      window.dispatchEvent(new Event("resize"));
    });
    // Still tracking after the layout shift (a fresh setBounds command fired).
    expect(
      shell.commands.filter((c) => c === "bounds:browser-tab:a").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("updates a computed host radius in place without recreating or navigating the WebView", async () => {
    const host = elementAt({ left: 8, top: 72, width: 368, height: 640 });
    host.style.overflow = "hidden";
    host.style.borderRadius = "24px";
    const surface = elementAt({ left: 8, top: 72, width: 368, height: 640 });
    host.append(surface);
    document.body.append(host);
    const shell = new RecordingShell();
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    act(() => result.current.registerSurfaceElement("a", surface));
    expect(
      shell.bounds.get("browser-tab:a")?.outerClip.cornerRadii.topLeft,
    ).toBe(24);

    shell.commands.length = 0;
    await act(async () => {
      host.style.borderRadius = "32px";
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });

    expect(
      shell.bounds.get("browser-tab:a")?.outerClip.cornerRadii.topLeft,
    ).toBe(32);
    expect(shell.commands).toContain("bounds:browser-tab:a");
    expect(shell.commands).not.toContain("create:browser-tab:a");
    expect(
      shell.commands.some((command) => command.startsWith("navigate:")),
    ).toBe(false);
  });

  it("retries identical geometry after a fire-and-forget native rejection", async () => {
    const shell = new DropFirstBoundsShell();
    const surface = elementAt({ left: 12, top: 34, width: 300, height: 500 });
    const { result } = renderHook(() =>
      useMobileNativeTabSurfaces({ ...base, shell }),
    );
    act(() => result.current.registerSurfaceElement("a", surface));
    expect(shell.commands).toContain("bounds-rejected:browser-tab:a");
    expect(shell.bounds.has("browser-tab:a")).toBe(false);

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });

    expect(shell.attempts).toBeGreaterThanOrEqual(2);
    expect(shell.bounds.get("browser-tab:a")).toMatchObject({
      x: 12,
      y: 34,
      width: 300,
      height: 500,
    });
    expect(
      shell.commands.filter((command) => command === "create:browser-tab:a"),
    ).toHaveLength(1);
    expect(shell.navigations).toEqual([]);
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

  it("keeps the native page foregrounded and updates its rounded chat hole while the sheet opens", async () => {
    const sheet = document.createElement("div");
    sheet.dataset.testid = "chat-sheet-surface";
    sheet.dataset.chatState = "INPUT";
    sheet.style.borderRadius = "32px";
    let bounds = { left: 12, top: 700, width: 360, height: 60 };
    sheet.getBoundingClientRect = () =>
      ({
        ...bounds,
        x: bounds.left,
        y: bounds.top,
        right: bounds.left + bounds.width,
        bottom: bounds.top + bounds.height,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.append(sheet);
    const shell = new RecordingShell();
    renderHook(() =>
      useMobileNativeTabSurfaces({
        ...base,
        occlusionSelector: '[data-testid="chat-sheet-surface"]',
        shell,
      }),
    );

    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 12, y: 700, width: 360, height: 60, cornerRadius: 32 },
    ]);
    expect(shell.commands.indexOf("occlusions:browser-tab:a")).toBeLessThan(
      shell.commands.indexOf("fg:browser-tab:a"),
    );

    shell.commands.length = 0;
    await act(async () => {
      document.body.dataset.elizaLayoutShiftIntent = "transient";
      bounds = { left: 0, top: 240, width: 384, height: 520 };
      sheet.dataset.chatState = "OPEN_HALF_OR_OVER";
      sheet.style.borderRadius = "24px";
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 0, y: 240, width: 384, height: 520, cornerRadius: 24 },
    ]);

    // MotionValue transforms do not require React or attribute writes. The
    // canonical transient marker keeps native geometry following those frames.
    await act(async () => {
      bounds = { left: 0, top: 80, width: 384, height: 680 };
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 0, y: 80, width: 384, height: 680, cornerRadius: 24 },
    ]);

    await act(async () => {
      document.body.removeAttribute("data-eliza-layout-shift-intent");
      bounds = { left: 12, top: 700, width: 360, height: 60 };
      sheet.dataset.chatState = "INPUT";
      sheet.style.borderRadius = "32px";
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(shell.occlusions.get("browser-tab:a")).toEqual([
      { x: 12, y: 700, width: 360, height: 60, cornerRadius: 32 },
    ]);
    expect(shell.commands).not.toContain("bg:browser-tab:a");
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
