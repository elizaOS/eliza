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
 * without the stamp simply render nothing.
 *
 * Tap (or the X) hides it for the rest of the session (sessionStorage), so it
 * is present by default for verification but never nags during real use.
 */

import { X } from "lucide-react";
import { useEffect, useState } from "react";

const BUILD_INFO_URL = "/build-info.json";
const DISMISS_KEY = "eliza.buildBadge.dismissed";

interface BuildInfo {
  commit?: string;
  builtAt?: string;
  label?: string;
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

export function BuildBadge() {
  const [label, setLabel] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() =>
    readSessionDismissed(),
  );

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

  if (dismissed || !label) return null;

  const dismiss = () => {
    writeSessionDismissed();
    setDismissed(true);
  };

  return (
    <div
      className="pointer-events-none fixed left-0 bottom-0 z-[9997]"
      style={{
        paddingLeft: "calc(env(safe-area-inset-left, 0px) + 0.375rem)",
        paddingBottom:
          "calc(max(env(safe-area-inset-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + var(--eliza-mobile-nav-offset, 0px) + 0.375rem)",
      }}
    >
      <button
        type="button"
        data-testid="build-badge"
        title="Build version (tap to hide for this session)"
        aria-label={`Build ${label}. Tap to hide for this session.`}
        onClick={dismiss}
        className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-surface/80 px-2 py-0.5 text-3xs leading-none text-muted opacity-70 transition-opacity hover:opacity-100"
      >
        <span className="font-mono tracking-tight">{label}</span>
        <X aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />
      </button>
    </div>
  );
}
