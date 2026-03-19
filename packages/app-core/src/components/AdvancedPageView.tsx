/**
 * AdvancedPageView — container for advanced configuration sub-tabs.
 *
 * Sub-tabs:
 *   - Plugins: Feature/connector plugin management
 *   - Skills: Custom agent skills
 *   - Fine-Tuning: Dataset and model training workflows
 *   - Trajectories: LLM call viewer and analysis
 *   - Runtime: Runtime object inspection
 *   - Databases: Tables/media/vector browser
 *   - Lifo: Browser-native terminal sandbox
 *   - Logs: Runtime log viewer
 */

import {
  DatabasePageView,
  LogsPageView,
  PluginsPageView,
  RuntimeView,
  SkillsView,
} from "@elizaos/app-core/components";
import type { Tab } from "@elizaos/app-core/navigation";
import { useApp } from "@elizaos/app-core/state";
import React, { type ReactNode, useState } from "react";
import { CustomActionsView } from "./CustomActionsView";
import { FineTuningView } from "./FineTuningView";
import { LifoSandboxView } from "./LifoSandboxView";
import { TrajectoriesView } from "./TrajectoriesView";
import { TrajectoryDetailView } from "./TrajectoryDetailView";

type SubTab =
  | "actions"
  | "plugins"
  | "skills"
  | "fine-tuning"
  | "trajectories"
  | "runtime"
  | "database"
  | "lifo"
  | "logs"

const SUB_TABS: Array<{ id: SubTab; label: string; description: string }> = [
  {
    id: "actions",
    label: "Actions",
    description: "Custom agent commands and workflows",
  },
  { id: "plugins", label: "Plugins", description: "Features and connectors" },
  { id: "skills", label: "Skills", description: "Custom agent skills" },
  // {
  //   id: "fine-tuning",
  //   label: "Fine-Tuning",
  //   description: "Dataset and model training workflows",
  // },
  {
    id: "trajectories",
    label: "Trajectories",
    description: "LLM call history and analysis",
  },
  {
    id: "runtime",
    label: "Runtime",
    description: "Deep runtime object introspection and load order",
  },
  {
    id: "database",
    label: "Database",
    description: "Tables, media, and vector browser",
  },
  // {
  //   id: "lifo",
  //   label: "Lifo",
  //   description: "Browser-native shell sandbox and file explorer",
  // },
  { id: "logs", label: "Logs", description: "Runtime and service logs" },
];

const MODAL_SUB_TABS = SUB_TABS.filter(
  (t) => t.id !== "plugins" && t.id !== "skills",
);

const SUBTAB_ICONS: Record<string, ReactNode> = {
  actions: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  "fine-tuning": (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  ),
  trajectories: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="19" r="3" />
      <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
      <circle cx="18" cy="5" r="3" />
    </svg>
  ),
  runtime: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  database: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  lifo: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  logs: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  security: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
};

function mapTabToSubTab(tab: Tab): SubTab {
  switch (tab) {
    case "actions":
      return "actions";
    case "plugins":
      return "plugins";
    case "skills":
      return "skills";
    case "fine-tuning":
      return "fine-tuning";
    case "trajectories":
      return "trajectories";
    case "runtime":
      return "runtime";
    case "database":
      return "database";
    case "lifo":
      return "lifo";
    case "logs":
      return "logs";
    default:
      return "plugins";
  }
}

export function AdvancedPageView({ inModal }: { inModal?: boolean } = {}) {
  const { tab, setTab } = useApp();
  const [selectedTrajectoryId, setSelectedTrajectoryId] = useState<
    string | null
  >(null);

  const currentSubTab = mapTabToSubTab(tab);
  const tabs = inModal ? MODAL_SUB_TABS : SUB_TABS;

  const handleSubTabChange = (subTab: SubTab) => {
    setSelectedTrajectoryId(null);
    setTab(subTab as Tab);
  };

  const renderContent = () => {
    switch (currentSubTab) {
      case "actions":
        return <CustomActionsView />;
      case "plugins":
        return <PluginsPageView />;
      case "skills":
        return <SkillsView />;
      case "fine-tuning":
        return <FineTuningView />;
      case "trajectories":
        if (selectedTrajectoryId) {
          return (
            <TrajectoryDetailView
              trajectoryId={selectedTrajectoryId}
              onBack={() => setSelectedTrajectoryId(null)}
            />
          );
        }
        return (
          <TrajectoriesView onSelectTrajectory={setSelectedTrajectoryId} />
        );
      case "runtime":
        return <RuntimeView />;
      case "database":
        return <DatabasePageView />;
      case "lifo":
        return <LifoSandboxView />;
      case "logs":
        return <LogsPageView />;
      default:
        return <PluginsPageView />;
    }
  };

  return (
    <div
      className={
        inModal ? "settings-modal-layout" : "flex flex-col h-full min-h-0"
      }
    >
      {inModal ? (
        <nav className="settings-icon-sidebar">
          {tabs.map((subTab) => (
            <button
              key={subTab.id}
              type="button"
              className={`advanced-subtab-btn settings-icon-btn ${currentSubTab === subTab.id ? "is-active" : ""}`}
              onClick={() => handleSubTabChange(subTab.id)}
              title={subTab.description}
            >
              {SUBTAB_ICONS[subTab.id]}
              <span className="settings-icon-label">{subTab.label}</span>
            </button>
          ))}
        </nav>
      ) : (
        <div className="mb-4 shrink-0">
          <div className="flex gap-1 border-b border-border">
            {tabs.map((subTab) => {
              const isActive = currentSubTab === subTab.id;
              return (
                <button
                  type="button"
                  key={subTab.id}
                  className={`advanced-subtab-btn px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${isActive
                    ? "border-accent text-txt"
                    : "border-transparent text-muted hover:text-txt hover:border-border"
                    }`}
                  onClick={() => handleSubTabChange(subTab.id)}
                  title={subTab.description}
                >
                  {subTab.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div
        className={
          inModal ? "settings-content-area" : "flex-1 min-h-0 overflow-y-auto"
        }
        style={
          inModal
            ? ({
              "--accent": "var(--section-accent-advanced, #7b8fb5)",
              "--surface": "rgba(255, 255, 255, 0.06)",
              "--s-accent": "#7b8fb5",
              "--s-text-txt": "#7b8fb5",
              "--s-accent-glow": "rgba(123, 143, 181, 0.35)",
              "--s-accent-subtle": "rgba(123, 143, 181, 0.12)",
              "--s-grid-line": "rgba(123, 143, 181, 0.02)",
              "--s-glow-edge": "rgba(123, 143, 181, 0.08)",
            } as React.CSSProperties)
            : undefined
        }
      >
        {inModal ? (
          <div className="settings-section-pane pt-4">{renderContent()}</div>
        ) : (
          renderContent()
        )}
      </div>
    </div>
  );
}
