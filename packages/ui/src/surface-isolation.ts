/**
 * Isolation-level catalogue for every shipped app surface (#13452) — the
 * durable, greppable answer to "which isolation level does each view use, and
 * why". A view renders into a shared shell tree; its {@link SurfaceIsolationLevel}
 * (declared on its surface manifest) states how far it is separated from the
 * host realm and from other views. This module documents the mapping AND is the
 * live typed source the shell/audit can read — a doc that cannot drift from the
 * code because it IS code.
 *
 * ── The four isolation levels and their per-platform embedding ──────────────
 *
 *  in-process — trusted first-party shell views run in the host DOM/React realm
 *    with the full host singleton (React, API client, native bridges). There is
 *    no sandbox: trust is the boundary. This is every built-in shell page (chat,
 *    settings, launcher pages, wallet/inventory, knowledge, logs, database, …).
 *    Web/desktop/mobile all render these in the same host webview. The manifest
 *    still scopes what they may touch (background, capabilities) even though they
 *    share the realm — isolation level and capability grants are orthogonal.
 *
 *  sandboxed-iframe — untrusted or third-party WEB views that must not share the
 *    host realm. They render in an `<iframe sandbox>` with a postMessage
 *    capability broker; MDN warns that `allow-scripts` + `allow-same-origin` on
 *    same-origin content is not a real sandbox, so the frame is served without
 *    `allow-same-origin` (opaque origin) and reaches the shell only through the
 *    broker (`navigate`/`storage`). `DynamicViewLoader` frames any view declaring
 *    this level; the `sandbox-probe` developer view is the shipped consumer.
 *
 *  native-webview — heavy or untrusted views that embed a NATIVE child
 *    web-content surface with its own renderer process and an explicit
 *    process/storage-sharing policy. Desktop uses an Electron/Electrobun
 *    `WebContentsView` (the successor to the deprecated `BrowserView`); iOS uses
 *    a `WKWebView` with a chosen `WKProcessPool`; Android uses a `WebView` with
 *    renderer isolation. The Browser view is the canonical consumer — it hosts
 *    arbitrary third-party web content and must never share the host realm.
 *
 *  immersive — a fullscreen surface that owns its whole window and is chrome-free
 *    (launcher/home, background editor). It is in-process like the shell but is
 *    the only non-launcher level allowed to paint the shared wallpaper — and only
 *    when its manifest also grants `wallpaper` (see {@link resolveSurfaceManifest}).
 *
 * ── Mapping current view families to levels ─────────────────────────────────
 *
 * The table below is authored per family, not per view id, because every view
 * in a family shares a level. A view's manifest may still override its level;
 * this is the DEFAULT catalogue the shell documents. New view families should be
 * added here when they ship so the doc stays complete.
 */

import type { SurfaceIsolationLevel } from "@elizaos/core";

/** A documented isolation assignment for a family of surfaces. */
export interface SurfaceIsolationEntry {
  /** The isolation level this family uses. */
  readonly level: SurfaceIsolationLevel;
  /** Why this level — the trust/weight rationale that picks it. */
  readonly rationale: string;
  /**
   * Representative view ids / families covered. Illustrative, not exhaustive —
   * the authoritative per-view level is the view's own manifest.
   */
  readonly examples: readonly string[];
}

/**
 * The default isolation catalogue keyed by level. Reading it top-to-bottom is
 * the isolation doc; iterating it is the audit source.
 */
export const SURFACE_ISOLATION_CATALOGUE: Readonly<
  Record<SurfaceIsolationLevel, SurfaceIsolationEntry>
> = {
  "in-process": {
    level: "in-process",
    rationale:
      "Trusted first-party shell views. They ship in the main bundle and need " +
      "the host React/API/bridge singletons; trust — not a sandbox — is the " +
      "boundary. The manifest still scopes their background and capability grants.",
    examples: [
      "chat",
      "settings",
      "wallet.inventory",
      "documents",
      "files",
      "plugins",
      "skills",
      "logs",
      "database",
      "trajectories",
      "memories",
      "relationships",
    ],
  },
  "sandboxed-iframe": {
    level: "sandboxed-iframe",
    rationale:
      "Untrusted / third-party WEB views. Rendered in an `<iframe sandbox>` " +
      "(`allow-scripts`, never `allow-same-origin` — so the document is opaque " +
      "origin and cannot reach host DOM/storage/cookies) with a postMessage " +
      "capability broker gating `navigate`/`storage`. `DynamicViewLoader` frames " +
      "any view whose manifest declares this level instead of importing it into " +
      "the host realm; the `sandbox-probe` developer view is the shipped " +
      "first-party consumer (see `SandboxedViewFrame.tsx`).",
    examples: ["sandbox-probe"],
  },
  "native-webview": {
    level: "native-webview",
    rationale:
      "Heavy / untrusted views hosting arbitrary web content. They embed a native " +
      "child web-content surface (desktop `WebContentsView`, iOS `WKWebView` with " +
      "its own `WKProcessPool`, Android `WebView` with renderer isolation) so the " +
      "content never shares the host renderer process.",
    examples: ["browser"],
  },
  immersive: {
    level: "immersive",
    rationale:
      "Fullscreen chrome-free surfaces that own their whole window. In-process " +
      "like the shell, but the only non-launcher level allowed to paint the " +
      "shared wallpaper — and only with the explicit `wallpaper` grant.",
    examples: ["views (launcher)", "apps (launcher)", "background", "home"],
  },
};

/** The catalogue entry for a level. */
export function isolationEntry(
  level: SurfaceIsolationLevel,
): SurfaceIsolationEntry {
  return SURFACE_ISOLATION_CATALOGUE[level];
}
