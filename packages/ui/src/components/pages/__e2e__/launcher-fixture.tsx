// Self-contained fixture for the Launcher e2e: mounts the real read-only
// Launcher with a single curated page of deterministic mock ViewEntry items,
// composed inside the REAL HomeLauncherSurface rail (the production shape) so
// the runner can drive the outer-rail back-to-home swipe exactly like a finger
// on device. A couple of entries carry an `imageUrl` data-URI to prove the
// launcher ignores hero images and still renders glyph-only app icons.
// Tap-launch is wired to a stub surfaced on `window.__launcherCalls` so the
// runner can assert the real interaction handlers fired. No app server, no
// network - fully self-contained (mirrors background-fixture's
// self-containment). Paired with run-launcher-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { ViewEntry } from "../../../hooks/view-catalog";
import { resetShellSurfaceForTests } from "../../../state/shell-surface-store";
import { HomeLauncherSurface } from "../../shell/HomeLauncherSurface";
import { Launcher } from "../Launcher";

type Win = typeof window & {
  __launcherCalls?: {
    launch: string[];
  };
};

// A deterministic gradient SVG data-URI kept on two entries to verify launcher
// tiles do not composite hero imagery from `imageUrl`.
function tileImage(a: string, b: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
       </linearGradient></defs>
       <rect width="160" height="160" rx="32" fill="url(#g)"/>
     </svg>`,
  )}`;
}

// Stable id list - the launcher is a single scrolling page (no pagination).
// Two entries carry a hero image URL that the launcher must ignore. Uniform
// tiles, read-only.
const SPECS: Array<{
  id: string;
  label: string;
  icon?: string;
  image?: boolean;
}> = [
  { id: "chat", label: "Chat", icon: "MessageSquare" },
  { id: "settings", label: "Settings", icon: "Shield" },
  { id: "wallet", label: "Wallet", icon: "Wallet", image: true },
  { id: "activity", label: "Activity", icon: "Activity" },
  { id: "inbox", label: "Inbox", icon: "Inbox" },
  { id: "calendar", label: "Calendar", icon: "CalendarDays" },
  { id: "health", label: "Health", icon: "Heart" },
  { id: "focus", label: "Focus", icon: "Focus" },
  { id: "companion", label: "Companion", icon: "Bot", image: true },
  { id: "feed", label: "Feed", icon: "Rss" },
  { id: "orchestrator", label: "Orchestrator", icon: "Bot" },
  { id: "trade", label: "Trading", icon: "TrendingUp" },
  { id: "shop", label: "Shop", icon: "ShoppingBag" },
  { id: "arcade", label: "Arcade", icon: "Gamepad2" },
  { id: "keys", label: "Keys", icon: "KeyRound" },
  { id: "notes", label: "Notes", icon: "NotebookPen" },
];

function makeEntry(spec: (typeof SPECS)[number]): ViewEntry {
  return {
    key: `view:${spec.id}`,
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    imageUrl: spec.image ? tileImage("#059669", "#e11d48") : undefined,
    hasHero: Boolean(spec.image),
    modality: "gui",
    modalities: ["gui"],
    state: "loaded",
    kind: "view",
    builtin: true,
  };
}

const ENTRIES: ViewEntry[] = SPECS.map(makeEntry);

function Harness(): React.JSX.Element {
  React.useLayoutEffect(() => {
    const win = window as Win;
    win.__launcherCalls = { launch: [] };
  }, []);

  return (
    <div
      data-testid="launcher-fixture-root"
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#0a0d16",
      }}
    >
      <HomeLauncherSurface
        initialPage="launcher"
        home={
          <div
            data-testid="fixture-home-content"
            style={{ height: "100%", padding: "64px 28px", color: "white" }}
          >
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Home</h1>
          </div>
        }
        launcher={
          <Launcher
            entries={ENTRIES}
            onLaunch={(entry) => {
              (window as Win).__launcherCalls?.launch.push(entry.id);
            }}
          />
        }
      />
    </div>
  );
}

resetShellSurfaceForTests();
const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
