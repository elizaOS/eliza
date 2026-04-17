/**
 * Skill marketplace — search/install modal and marketplace result cards.
 *
 * Extracted from SkillsView.tsx to keep individual files under ~500 LOC.
 */

import {
  AdminDialog,
  AdminDialogContent,
  AdminDialogHeader,
  AdminInput,
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
} from "@elizaos/ui";
import { useState } from "react";
import type { SkillInfo, SkillMarketplaceResult } from "../../api";
import { useApp } from "../../state";

/* ── Marketplace Result Card ────────────────────────────────────────── */

export function MarketplaceCard({
  item,
  isInstalled,
  skillsMarketplaceAction,
  onInstall,
  onUninstall,
}: {
  item: SkillMarketplaceResult;
  isInstalled: boolean;
  skillsMarketplaceAction: string;
  onInstall: (item: SkillMarketplaceResult) => void;
  onUninstall: (skillId: string, name: string) => void;
}) {
  const { t } = useApp();
  const isInstalling = skillsMarketplaceAction === `install:${item.id}`;
  const isUninstalling = skillsMarketplaceAction === `uninstall:${item.id}`;
  const sourceLabel = item.repository || item.slug || item.id;

  return (
    <div className="flex items-start gap-4 p-4 border border-border bg-card hover:border-accent/50 transition-colors">
      {/* Icon placeholder */}
      <div className="w-10 h-10 shrink-0 flex items-center justify-center bg-accent/10 text-accent text-sm font-bold rounded">
        {item.name.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-txt">{item.name}</div>
        <div className="text-xs-tight text-muted mt-0.5 line-clamp-2">
          {item.description || t("skillsview.noDescription")}
        </div>
        <div className="flex items-center gap-2 mt-1.5 text-2xs text-muted">
          <span className="font-mono">{sourceLabel}</span>
          {item.score != null && (
            <>
              <span className="text-border">/</span>
              <span>
                {t("skillsview.score")} {item.score.toFixed(2)}
              </span>
            </>
          )}
          {item.tags && item.tags.length > 0 && (
            <>
              <span className="text-border">/</span>
              {item.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-px bg-accent/10 text-accent"
                >
                  {tag}
                </span>
              ))}
            </>
          )}
        </div>
      </div>
      {isInstalled ? (
        <Button
          variant="destructive"
          size="sm"
          className="h-8 px-4 text-xs-tight font-bold tracking-wide shadow-sm shrink-0"
          onClick={() => onUninstall(item.id, item.name)}
          disabled={isUninstalling}
        >
          {isUninstalling
            ? t("skillsview.removing", { defaultValue: "Removing..." })
            : t("skillsview.Uninstall", { defaultValue: "Uninstall" })}
        </Button>
      ) : (
        <Button
          variant="default"
          size="sm"
          className="h-8 px-4 text-xs-tight font-bold tracking-wide shadow-sm shrink-0"
          onClick={() => onInstall(item)}
          disabled={isInstalling}
        >
          {isInstalling
            ? t("skillsview.installing", { defaultValue: "Installing..." })
            : t("skillsview.Install")}
        </Button>
      )}
    </div>
  );
}

/* ── Install Modal ──────────────────────────────────────────────────── */

type InstallTab = "search" | "url";

export function InstallModal({
  skills,
  skillsMarketplaceQuery,
  skillsMarketplaceResults,
  skillsMarketplaceError,
  skillsMarketplaceLoading,
  skillsMarketplaceAction,
  skillsMarketplaceManualGithubUrl,
  searchSkillsMarketplace,
  installSkillFromMarketplace,
  uninstallMarketplaceSkill,
  installSkillFromGithubUrl,
  setState,
  onClose,
}: {
  skills: SkillInfo[];
  skillsMarketplaceQuery: string;
  skillsMarketplaceResults: SkillMarketplaceResult[];
  skillsMarketplaceError: string;
  skillsMarketplaceLoading: boolean;
  skillsMarketplaceAction: string;
  skillsMarketplaceManualGithubUrl: string;
  searchSkillsMarketplace: () => Promise<void>;
  installSkillFromMarketplace: (item: SkillMarketplaceResult) => Promise<void>;
  uninstallMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
  installSkillFromGithubUrl: () => Promise<void>;
  setState: ReturnType<typeof useApp>["setState"];
  onClose: () => void;
}) {
  const { t } = useApp();
  const [tab, setTab] = useState<InstallTab>("search");
  const installTabs = [
    {
      id: "search" as const,
      label: t("skillsview.marketplaceTab", {
        defaultValue: "Marketplace",
      }),
    },
    {
      id: "url" as const,
      label: t("skillsview.githubUrlTab", {
        defaultValue: "GitHub URL",
      }),
    },
  ] as const;

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <AdminDialogContent
        container={typeof document !== "undefined" ? document.body : undefined}
        className="max-h-[80vh] max-w-2xl"
      >
        <AdminDialogHeader>
          <DialogTitle className="text-sm font-extrabold uppercase tracking-[0.14em]">
            {t("skillsview.installSkillTitle", {
              defaultValue: "Install Skill",
            })}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs-tight text-muted">
            {t("skillsview.installSkillDescription", {
              defaultValue:
                "Add skills from the marketplace or a GitHub repository.",
            })}
          </DialogDescription>
        </AdminDialogHeader>
        <AdminDialog.SegmentedTabList
          role="tablist"
          aria-label={t("skillsview.installSkillSource", {
            defaultValue: "Install skill source",
          })}
        >
          {installTabs.map((t) => (
            <AdminDialog.SegmentedTab
              key={t.id}
              active={tab === t.id}
              role="tab"
              id={`skills-install-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`skills-install-panel-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </AdminDialog.SegmentedTab>
          ))}
        </AdminDialog.SegmentedTabList>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "search" && (
            <div
              id="skills-install-panel-search"
              role="tabpanel"
              aria-labelledby="skills-install-tab-search"
            >
              <div className="flex gap-2 items-center mb-4">
                <AdminInput
                  type="text"
                  style={{ flex: 1, minWidth: 200 }}
                  placeholder={t("skillsview.searchByKeyword")}
                  aria-label={t("skillsview.searchByKeyword", {
                    defaultValue: "Search skills marketplace",
                  })}
                  value={skillsMarketplaceQuery}
                  onChange={(e) =>
                    setState("skillsMarketplaceQuery", e.target.value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void searchSkillsMarketplace();
                  }}
                />
                <Button
                  variant="default"
                  size="sm"
                  type="button"
                  className="plugins-game-chip"
                  style={{ minHeight: 36, padding: "0 16px", fontWeight: 700 }}
                  onClick={() => searchSkillsMarketplace()}
                  disabled={skillsMarketplaceLoading}
                >
                  {skillsMarketplaceLoading
                    ? t("skillsview.searching", {
                        defaultValue: "Searching...",
                      })
                    : t("skillsview.search", { defaultValue: "Search" })}
                </Button>
              </div>

              {skillsMarketplaceError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-danger/35 bg-danger/10 p-2.5 text-xs text-danger"
                >
                  {skillsMarketplaceError}
                </div>
              )}

              {skillsMarketplaceResults.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-xs uppercase tracking-[0.1em] text-muted">
                    {t("skillsview.searchAboveToDiscoverSkills", {
                      defaultValue: "Search above to discover skills.",
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="text-xs-tight text-muted mb-1">
                    {skillsMarketplaceResults.length} {t("skillsview.result")}
                    {skillsMarketplaceResults.length !== 1 ? "s" : ""}
                  </div>
                  {skillsMarketplaceResults.map((item) => (
                    <MarketplaceCard
                      key={item.id}
                      item={item}
                      isInstalled={skills.some((s) => s.id === item.id)}
                      skillsMarketplaceAction={skillsMarketplaceAction}
                      onInstall={installSkillFromMarketplace}
                      onUninstall={uninstallMarketplaceSkill}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "url" && (
            <div
              id="skills-install-panel-url"
              role="tabpanel"
              aria-labelledby="skills-install-tab-url"
            >
              <div className="mb-1 text-xs font-semibold text-txt">
                {t("skillsview.githubRepositoryUrl", {
                  defaultValue: "GitHub Repository URL",
                })}
              </div>
              <div className="mb-3 text-xs-tight text-muted">
                {t("skillsview.githubRepositoryDesc", {
                  defaultValue:
                    "Paste a full GitHub repository URL to install a skill directly.",
                })}
              </div>
              <div className="flex gap-2 items-center">
                <AdminInput
                  type="text"
                  style={{ flex: 1 }}
                  placeholder="https://github.com/org/repo"
                  aria-label={t("skillsview.githubRepositoryUrl", {
                    defaultValue: "GitHub Repository URL",
                  })}
                  value={skillsMarketplaceManualGithubUrl}
                  onChange={(e) =>
                    setState("skillsMarketplaceManualGithubUrl", e.target.value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void installSkillFromGithubUrl();
                  }}
                />
                <Button
                  variant="default"
                  size="sm"
                  type="button"
                  className="plugins-game-chip"
                  style={{ minHeight: 36, padding: "0 16px", fontWeight: 700 }}
                  onClick={() => installSkillFromGithubUrl()}
                  disabled={
                    skillsMarketplaceAction === "install:manual" ||
                    !skillsMarketplaceManualGithubUrl.trim()
                  }
                >
                  {skillsMarketplaceAction === "install:manual"
                    ? t("skillsview.installing", {
                        defaultValue: "Installing...",
                      })
                    : t("skillsview.Install")}
                </Button>
              </div>

              {skillsMarketplaceError && (
                <div
                  role="alert"
                  className="mt-3 rounded-lg border border-danger/35 bg-danger/10 p-2.5 text-xs text-danger"
                >
                  {skillsMarketplaceError}
                </div>
              )}
            </div>
          )}
        </div>
      </AdminDialogContent>
    </Dialog>
  );
}
