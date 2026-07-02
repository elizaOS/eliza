// Evidence fixture — mounts the REAL Launcher with pages computed by the REAL
// curateLauncherPages over the realistic view set (mirrors the
// launcher-curation full-realistic-set test). The query string picks the
// toggle state:
//   ?mode=before     — developer:true  (the old bun-run-dev default)
//   ?mode=after      — developer:false (the new default on every build)
//   ?mode=toggled-on — developer:true  (user flipped Settings → Developer views)
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Launcher } from "@ui/components/pages/Launcher";
import { curateLauncherPages } from "@ui/components/pages/launcher-curation";
import type { ViewEntry } from "@ui/hooks/view-catalog";

function entry(id: string, over: Partial<ViewEntry> = {}): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label: id
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" "),
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
    path: `/${id}`,
    ...over,
  } as ViewEntry;
}

const REAL_VIEWS: ViewEntry[] = [
  entry("chat", { viewKind: "system", icon: "MessageSquare" }),
  entry("settings", { viewKind: "system", icon: "Settings" }),
  entry("wallet", { viewKind: "system", icon: "Wallet" }),
  entry("automations", { viewKind: "system", icon: "Zap" }),
  entry("browser", { icon: "Globe" }),
  entry("character", { viewKind: "system", icon: "Bot" }),
  entry("documents", { viewKind: "system", icon: "FileText" }),
  entry("transcripts", { viewKind: "system", icon: "FileText" }),
  entry("relationships", { viewKind: "system", icon: "Network" }),
  entry("rolodex", { builtin: true, icon: "UsersRound" }),
  entry("memories", { viewKind: "system", icon: "BrainCircuit" }),
  entry("feed", { viewKind: "system", icon: "Rss" }),
  entry("stream", { icon: "Radio" }),
  // Developer tooling — page 2 when the toggle is on.
  entry("trajectories", { viewKind: "developer", icon: "Activity" }),
  entry("database", { viewKind: "developer", icon: "Database" }),
  entry("runtime", { builtin: true, icon: "Terminal" }),
  entry("logs", { viewKind: "developer", icon: "ScrollText" }),
  entry("skills", { builtin: true, icon: "Sparkles" }),
  entry("plugins", { viewKind: "system", icon: "Plug" }),
  entry("vector-browser", { viewKind: "developer", icon: "Database" }),
];

const mode =
  new URLSearchParams(window.location.search).get("mode") ?? "after";
const developer = mode === "before" || mode === "toggled-on";

const pages = curateLauncherPages(REAL_VIEWS, {
  isAosp: false,
  enabledKinds: { developer, preview: false },
  cloudActive: false,
});
const entries = pages.flat();
const pageGroups = pages.map((p) => p.map((e) => e.id));

declare global {
  interface Window {
    __policyPages?: string[][];
  }
}
window.__policyPages = pageGroups;

function Harness(): React.JSX.Element {
  const [page, setPage] = React.useState(0);
  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background:
          "linear-gradient(160deg,#1b0f06 0%,#3a1c08 45%,#7c3a10 100%)",
      }}
    >
      <div
        style={{
          color: "#fff",
          font: "600 13px system-ui",
          padding: "10px 16px",
          opacity: 0.8,
        }}
        data-testid="policy-mode-banner"
      >
        mode={mode} · developer views {developer ? "ON" : "OFF (default)"} ·
        pages={pages.length}
      </div>
      <Launcher
        entries={entries}
        pageGroups={pageGroups}
        onLaunch={() => {}}
        page={page}
        onPageChange={setPage}
        showPageDots
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
