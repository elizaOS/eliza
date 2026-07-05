/**
 * BuildBadge — tiny fixed-position build/version pill so testers can verify
 * at a glance exactly which build the PWA is serving (cache-freshness check).
 *
 * Reads `/build-info.json` from the web root (best-effort; renders nothing
 * when the file is missing or malformed). Shape:
 *   { "commit": "58f6bb3beb", "builtAt": "…", "label": "58f6bb3beb · Jul 03 17:42 MDT" }
 *
 * The file is stamped at build time (see packages/app/scripts/build.mjs) and is
 * gitignored, so local dev / CI builds get a live sha while production bundles
 * without the stamp simply render nothing — i.e. this whole component (badge +
 * diagnostics overlay) is STAMPED-BUILDS-ONLY and costs nothing in prod.
 *
 * Tap the badge opens a tiny on-device diagnostics overlay (body classes,
 * Capacitor platform, display-mode matches, viewport heights, safe-area) so a
 * screenshot is ground truth instead of a blind guess — this ends the
 * blind-fix loop for the installed-PWA lockdown. The X hides the badge for the
 * rest of the session (sessionStorage), so it never nags during real use.
 */

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const BUILD_INFO_URL = "/build-info.json";
const DISMISS_KEY = "eliza.buildBadge.dismissed";

interface BuildInfo {
  commit?: string;
  builtAt?: string;
  label?: string;
}

/** A single diagnostic line: label + measured value. */
interface DiagRow {
  k: string;
  v: string;
}

function readSessionDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSessionDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Storage unavailable (private mode / quota) — in-memory hide still works.
  }
}

function toLabel(info: BuildInfo | null): string | null {
  if (!info) return null;
  if (typeof info.label === "string" && info.label.trim()) {
    return info.label.trim();
  }
  const commit = typeof info.commit === "string" ? info.commit.trim() : "";
  const builtAt = typeof info.builtAt === "string" ? info.builtAt.trim() : "";
  if (commit && builtAt) return `${commit.slice(0, 7)} · ${builtAt}`;
  if (commit) return commit.slice(0, 10);
  return null;
}

/** True when the given display-mode media query currently matches. */
function matchesDisplayMode(mode: string): boolean {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia(`(display-mode: ${mode})`).matches
    );
  } catch {
    return false;
  }
}

/** Measure a CSS length unit in px by probing an off-screen element. */
function measureCssHeight(value: string): number | null {
  try {
    const probe = document.createElement("div");
    probe.style.cssText = `position:fixed;top:0;left:-9999px;width:1px;height:${value};visibility:hidden;pointer-events:none;`;
    document.body.appendChild(probe);
    const px = probe.getBoundingClientRect().height;
    probe.remove();
    return Number.isFinite(px) ? Math.round(px) : null;
  } catch {
    return null;
  }
}

/** Read a computed CSS env()/custom-property length off the root element. */
function readRootLength(expr: string): string {
  try {
    const probe = document.createElement("div");
    probe.style.cssText = `position:fixed;top:0;left:-9999px;height:${expr};visibility:hidden;pointer-events:none;`;
    document.documentElement.appendChild(probe);
    const px = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    return `${px}px`;
  } catch {
    return "?";
  }
}

/** Best-effort Capacitor platform string without importing the plugin. */
function readCapacitorPlatform(): string {
  try {
    const cap = (window as { Capacitor?: { getPlatform?: () => string } })
      .Capacitor;
    if (cap?.getPlatform) return cap.getPlatform();
  } catch {
    /* not present */
  }
  return "web?";
}

/** Snapshot the live device/layout state that decides the PWA lockdown. */
function collectDiagnostics(): DiagRow[] {
  const bodyClasses = document.body.className.trim() || "(none)";
  const modes = ["standalone", "fullscreen", "minimal-ui", "browser"]
    .filter(matchesDisplayMode)
    .join(", ") || "(none)";
  const coarse = (() => {
    try {
      return window.matchMedia("(pointer: coarse)").matches ? "coarse" : "fine";
    } catch {
      return "?";
    }
  })();
  const nav = navigator as Navigator & { standalone?: boolean };
  const vv = window.visualViewport;

  return [
    { k: "body.class", v: bodyClasses },
    {
      k: "pwa-standalone",
      v: document.body.classList.contains("pwa-standalone") ? "YES" : "no",
    },
    { k: "capacitor", v: readCapacitorPlatform() },
    { k: "display-mode", v: modes },
    { k: "pointer", v: coarse },
    {
      k: "nav.standalone",
      v: typeof nav.standalone === "boolean" ? String(nav.standalone) : "n/a",
    },
    { k: "innerHeight", v: `${window.innerHeight}px` },
    { k: "100dvh", v: `${measureCssHeight("100dvh") ?? "?"}px` },
    { k: "100lvh", v: `${measureCssHeight("100lvh") ?? "?"}px` },
    { k: "100svh", v: `${measureCssHeight("100svh") ?? "?"}px` },
    {
      k: "visualViewport.h",
      v: vv ? `${Math.round(vv.height)}px` : "n/a",
    },
    { k: "safe-inset-bottom", v: readRootLength("env(safe-area-inset-bottom, 0px)") },
    {
      k: "body.position",
      v: getComputedStyle(document.body).position || "?",
    },
    {
      k: "body.touch-action",
      v: getComputedStyle(document.body).touchAction || "?",
    },
  ];
}

export function BuildBadge() {
  const [label, setLabel] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() =>
    readSessionDismissed(),
  );
  const [diag, setDiag] = useState<DiagRow[] | null>(null);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(BUILD_INFO_URL, { cache: "no-store" });
        if (!res.ok) return;
        const info = (await res.json()) as BuildInfo;
        if (!cancelled) setLabel(toLabel(info));
      } catch {
        // Best-effort: no build info available (production builds without the
        // build-time stamp). Stay hidden silently.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  const openDiag = useCallback(() => {
    setDiag(collectDiagnostics());
  }, []);

  const closeDiag = useCallback(() => setDiag(null), []);

  const dismiss = useCallback(() => {
    writeSessionDismissed();
    setDismissed(true);
  }, []);

  if (dismissed || !label) return null;

  return (
    <>
      <div
        className="pointer-events-none fixed left-0 bottom-0 z-[9997]"
        style={{
          paddingLeft: "calc(env(safe-area-inset-left, 0px) + 0.375rem)",
          paddingBottom:
            "calc(max(env(safe-area-inset-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + var(--eliza-mobile-nav-offset, 0px) + 0.375rem)",
        }}
      >
        <span className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-surface/80 px-2 py-0.5 text-3xs leading-none text-muted opacity-70 transition-opacity hover:opacity-100">
          <button
            type="button"
            data-testid="build-badge"
            title="Build version (tap for on-device diagnostics)"
            aria-label={`Build ${label}. Tap for on-device diagnostics.`}
            onClick={openDiag}
            className="font-mono tracking-tight"
          >
            {label}
          </button>
          <button
            type="button"
            data-testid="build-badge-dismiss"
            title="Hide for this session"
            aria-label="Hide build badge for this session"
            onClick={dismiss}
          >
            <X aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />
          </button>
        </span>
      </div>

      {diag ? (
        <div
          data-testid="build-badge-diag"
          className="pointer-events-auto fixed inset-0 z-[9998] flex items-end justify-start p-2"
          style={{
            paddingLeft: "calc(env(safe-area-inset-left, 0px) + 0.5rem)",
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)",
          }}
          onClick={closeDiag}
        >
          <div
            className="max-h-[70vh] w-full max-w-sm overflow-auto rounded-lg border border-border bg-surface/95 p-3 text-2xs shadow-lg backdrop-blur"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-3xs text-muted">{label}</span>
              <button
                type="button"
                data-testid="build-badge-diag-close"
                aria-label="Close diagnostics"
                onClick={closeDiag}
                className="text-muted hover:text-foreground"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono leading-tight">
              {diag.map((row) => (
                <div key={row.k} className="contents">
                  <dt className="text-muted">{row.k}</dt>
                  <dd className="break-all text-foreground">{row.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
    </>
  );
}
