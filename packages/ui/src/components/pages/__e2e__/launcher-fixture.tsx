// Self-contained fixture for the Launcher e2e: mounts the real Launcher
// (the iOS-like view-launcher) with 27 deterministic mock ViewEntry items.
// The launcher has no dock, so all 27 tiles flow onto the 24-per-page grid and
// overflow onto 2 pages — exercising the production first-run UX (overflow
// pagination). A couple carry an `imageUrl` data-URI so an image tile renders;
// the rest fall back to the Lucide glyph. Launch / edit / delete are wired to
// stubs and surfaced on `window.__launcherCalls` so the runner can assert the
// real interaction handlers fired. No app server, no network — fully
// self-contained (mirrors background-fixture's self-containment). Paired with
// run-launcher-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { ViewEntry } from "../../../hooks/view-catalog";
import { LAUNCHER_PAGE_SIZE } from "../../../state/launcher-layout";
import { Launcher } from "../Launcher";

type Win = typeof window & {
  __launcherCalls?: {
    launch: string[];
    edit: string[];
    delete: string[];
  };
};

// A deterministic gradient SVG data-URI so an image tile renders without any
// network fetch. Two entries use this; the rest render the glyph fallback.
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

// Stable id list (25) — two are "manageable" dynamic-developer views so the
// per-tile edit/delete affordances render in edit mode; the rest are plain
// views, two of which carry a hero image. Every tile is uniform (no dock).
const SPECS: Array<{ id: string; label: string; icon?: string; image?: boolean }> =
  [
    { id: "chat", label: "Chat", icon: "MessageSquare" },
    { id: "views", label: "Views", icon: "LayoutGrid" },
    { id: "settings", label: "Settings", icon: "Shield" },
    { id: "activity", label: "Activity", icon: "Activity" },
    { id: "wallet", label: "Wallet", icon: "Wallet", image: true },
    { id: "inbox", label: "Inbox", icon: "Inbox" },
    { id: "calendar", label: "Calendar", icon: "CalendarDays" },
    { id: "health", label: "Health", icon: "Heart" },
    { id: "focus", label: "Focus", icon: "Focus" },
    { id: "contacts", label: "Contacts", icon: "UsersRound" },
    { id: "phone", label: "Phone", icon: "Phone" },
    { id: "companion", label: "Companion", icon: "Bot", image: true },
    { id: "models", label: "Model Tester", icon: "TestTube2" },
    { id: "vectors", label: "Vector Browser", icon: "Database" },
    { id: "trajectory", label: "Trajectory", icon: "Activity" },
    { id: "feed", label: "Feed", icon: "Rss" },
    { id: "orchestrator", label: "Orchestrator", icon: "Bot" },
    { id: "training", label: "Fine-Tuning", icon: "BrainCircuit" },
    { id: "trade", label: "Trading", icon: "TrendingUp" },
    { id: "shop", label: "Shop", icon: "ShoppingBag" },
    { id: "glasses", label: "Glasses", icon: "Glasses" },
    { id: "arcade", label: "Arcade", icon: "Gamepad2" },
    { id: "screenshare", label: "Screen Share", icon: "Monitor" },
    { id: "keys", label: "Keys", icon: "KeyRound" },
    { id: "network", label: "Network", icon: "Network" },
    { id: "notes", label: "Notes", icon: "NotebookPen" },
    { id: "camera", label: "Camera", icon: "Camera" },
  ];

// The paging assertions need the tiles to overflow one page. Fail at bundle
// time — not as a misleading "no Page 2 dot" e2e failure — if a future
// page-size change silently collapses the fixture to one page.
if (SPECS.length <= LAUNCHER_PAGE_SIZE) {
  throw new Error(
    `launcher-fixture: ${SPECS.length} specs must exceed LAUNCHER_PAGE_SIZE=${LAUNCHER_PAGE_SIZE} for the multi-page assertions`,
  );
}

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

// "Dynamic developer" views that expose the per-tile edit/delete affordances in
// edit mode. Keep it small + deterministic.
const MANAGEABLE = new Set<string>(["models", "vectors"]);

function Harness(): React.JSX.Element {
  React.useLayoutEffect(() => {
    const win = window as Win;
    win.__launcherCalls = { launch: [], edit: [], delete: [] };
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
      <Launcher
        entries={ENTRIES}
        onLaunch={(entry) => {
          (window as Win).__launcherCalls?.launch.push(entry.id);
        }}
        canManageView={(id) => MANAGEABLE.has(id)}
        onEditView={(id) => {
          (window as Win).__launcherCalls?.edit.push(id);
        }}
        onDeleteView={(id) => {
          (window as Win).__launcherCalls?.delete.push(id);
        }}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
