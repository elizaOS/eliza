/**
 * Skill marketplace — search/install modal and marketplace result cards.
 *
 * Extracted from SkillsView.tsx to keep individual files under ~500 LOC.
 */

import { useState } from "react";
import { useAgentElement } from "../../agent-surface";
import type { SkillInfo, SkillMarketplaceResult } from "../../api";
import { type useApp, useAppSelector } from "../../state";
import {
  AdminDialog,
  AdminDialogContent,
  AdminDialogHeader,
  AdminInput,
} from "../ui/admin-dialog";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogTitle } from "../ui/dialog";

/* ── Agent-surface helpers ──────────────────────────────────────────── */

type MarketplaceActionVariant = "default" | "outline" | "ghost" | "destructive";

function MarketplaceActionButton({
  id,
  label,
  description,
  variant,
  className,
  disabled,
  testId,
  children,
  onActivate,
}: {
  id: string;
  label: string;
  description: string;
  variant: MarketplaceActionVariant;
  className: string;
  disabled?: boolean;
  testId?: string;
  children: React.ReactNode;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id,
    role: "button",
    label,
    group: "skill-marketplace",
    description,
    onActivate,
  });
  return (
    <Button
      ref={ref}
      variant={variant}
      size="sm"
      className={className}
      onClick={onActivate}
      disabled={disabled}
      data-testid={testId}
      {...agentProps}
    >
      {children}
    </Button>
  );
}

function InstallSourceTab({
  id,
  label,
  active,
  onSelect,
}: {
  id: "search" | "url";
  label: string;
  active: boolean;
  onSelect: (id: "search" | "url") => void;
}) {
  const { agentProps } = useAgentElement<HTMLButtonElement>({
    id: `skill-install-tab-${id}`,
    role: "tab",
    label,
    group: "skill-install",
    status: active ? "active" : "inactive",
    description: `Switch to the ${label} install source`,
    onActivate: () => onSelect(id),
  });
  return (
    <AdminDialog.SegmentedTab
      active={active}
      role="tab"
      id={`skills-install-tab-${id}`}
      aria-selected={active}
      aria-controls={`skills-install-panel-${id}`}
      onClick={() => onSelect(id)}
      {...agentProps}
    >
      {label}
    </AdminDialog.SegmentedTab>
  );
}

function SkillSearchField({
  value,
  placeholder,
  ariaLabel,
  onChange,
  onSubmit,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "skill-install-search-input",
    role: "text-input",
    label: "Search skills marketplace",
    group: "skill-install",
    description: "Search the skills marketplace by keyword",
    getValue: () => value,
    onFill: (next) => onChange(next),
  });
  return (
    <AdminInput
      ref={ref}
      type="text"
      style={{ flex: 1, minWidth: 200 }}
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit();
      }}
      {...agentProps}
    />
  );
}

function SkillUrlField({
  value,
  ariaLabel,
  onChange,
  onSubmit,
}: {
  value: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "skill-install-url-input",
    role: "text-input",
    label: "GitHub repository URL",
    group: "skill-install",
    description: "Paste a GitHub repository URL to install a skill",
    getValue: () => value,
    onFill: (next) => onChange(next),
  });
  return (
    <AdminInput
      ref={ref}
      type="text"
      style={{ flex: 1 }}
      placeholder="https://github.com/org/repo"
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit();
      }}
      {...agentProps}
    />
  );
}

function SkillInstallSubmitButton({
  id,
  label,
  description,
  disabled,
  children,
  onActivate,
}: {
  id: string;
  label: string;
  description: string;
  disabled?: boolean;
  children: React.ReactNode;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id,
    role: "button",
    label,
    group: "skill-install",
    description,
    onActivate,
  });
  return (
    <Button
      ref={ref}
      variant="default"
      size="sm"
      type="button"
      className="plugins-game-chip"
      style={{ minHeight: 36, padding: "0 16px", fontWeight: 700 }}
      onClick={onActivate}
      disabled={disabled}
      {...agentProps}
    >
      {children}
    </Button>
  );
}

/* ── Marketplace Result Card ────────────────────────────────────────── */

export function MarketplaceCard({
  item,
  installedSkill,
  skillsMarketplaceAction,
  onInstall,
  onUninstall,
  onEnable,
  onDisable,
  onCopy,
  onDetails,
}: {
  item: SkillMarketplaceResult;
  installedSkill: SkillInfo | null;
  skillsMarketplaceAction: string;
  onInstall: (item: SkillMarketplaceResult) => void;
  onUninstall: (skillId: string, name: string) => void;
  onEnable: (skillId: string, name: string) => void;
  onDisable: (skillId: string, name: string) => void;
  onCopy: (skillId: string, name: string) => void;
  onDetails: (skillId: string) => void;
}) {
  const t = useAppSelector((s) => s.t);
  const isInstalling = skillsMarketplaceAction === `install:${item.id}`;
  const isUninstalling = skillsMarketplaceAction === `uninstall:${item.id}`;
  const isToggling =
    skillsMarketplaceAction === `enable:${item.id}` ||
    skillsMarketplaceAction === `disable:${item.id}`;
  const isCopying = skillsMarketplaceAction === `copy:${item.id}`;
  const sourceLabel = item.repository || item.slug || item.id;

  const installed = Boolean(installedSkill);
  const enabled = installed && installedSkill?.enabled === true;
  const stateBadge = !installed
    ? {
        label: t("skillsview.statusNotInstalled", {
          defaultValue: "Not installed",
        }),
        tone: "muted" as const,
      }
    : enabled
      ? {
          label: t("common.active", { defaultValue: "Enabled" }),
          tone: "success" as const,
        }
      : {
          label: t("common.inactive", { defaultValue: "Disabled" }),
          tone: "warning" as const,
        };

  return (
    <div
      className="flex items-start gap-4 p-4 border border-border bg-card hover:border-accent/50 transition-colors"
      data-testid={`skill-result-card-${item.id}`}
    >
      <div className="w-10 h-10 shrink-0 flex items-center justify-center bg-accent/10 text-accent text-sm font-bold rounded-sm">
        {item.name.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="font-semibold text-sm text-txt">{item.name}</div>
          <span
            className={`px-1.5 py-px text-2xs font-bold uppercase tracking-wider rounded-sm ${
              stateBadge.tone === "success"
                ? "bg-success/15 text-success"
                : stateBadge.tone === "warning"
                  ? "bg-warning/15 text-warning"
                  : "bg-muted/15 text-muted"
            }`}
          >
            {stateBadge.label}
          </span>
        </div>
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
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 max-w-[18rem]">
        {!installed ? (
          <>
            <MarketplaceActionButton
              id={`skill-${item.id}-install`}
              label={`Install ${item.name}`}
              description={`Install the ${item.name} skill`}
              variant="default"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide "
              disabled={isInstalling}
              testId={`skill-action-install-${item.id}`}
              onActivate={() => onInstall(item)}
            >
              {isInstalling
                ? t("common.installing", { defaultValue: "Installing..." })
                : t("common.install")}
            </MarketplaceActionButton>
            <MarketplaceActionButton
              id={`skill-${item.id}-details`}
              label={`${item.name} details`}
              description={`Show details for ${item.name}`}
              variant="ghost"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide"
              testId={`skill-action-details-${item.id}`}
              onActivate={() => onDetails(item.id)}
            >
              {t("skillsview.details", { defaultValue: "Details" })}
            </MarketplaceActionButton>
          </>
        ) : enabled ? (
          <>
            <MarketplaceActionButton
              id={`skill-${item.id}-disable`}
              label={`Disable ${item.name}`}
              description={`Disable the ${item.name} skill`}
              variant="outline"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide"
              disabled={isToggling}
              testId={`skill-action-disable-${item.id}`}
              onActivate={() => onDisable(item.id, item.name)}
            >
              {isToggling
                ? t("skillsview.updating", { defaultValue: "Updating..." })
                : t("skillsview.Disable", { defaultValue: "Disable" })}
            </MarketplaceActionButton>
            <MarketplaceActionButton
              id={`skill-${item.id}-copy`}
              label={`Copy ${item.name} SKILL.md`}
              description={`Copy the SKILL.md source for ${item.name}`}
              variant="ghost"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide"
              disabled={isCopying}
              testId={`skill-action-copy-${item.id}`}
              onActivate={() => onCopy(item.id, item.name)}
            >
              {isCopying
                ? t("skillsview.copying", { defaultValue: "Copying..." })
                : t("skillsview.copySkillMd", {
                    defaultValue: "Copy SKILL.md",
                  })}
            </MarketplaceActionButton>
            <MarketplaceActionButton
              id={`skill-${item.id}-details`}
              label={`${item.name} details`}
              description={`Show details for ${item.name}`}
              variant="ghost"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide"
              testId={`skill-action-details-${item.id}`}
              onActivate={() => onDetails(item.id)}
            >
              {t("skillsview.details", { defaultValue: "Details" })}
            </MarketplaceActionButton>
          </>
        ) : (
          <>
            <MarketplaceActionButton
              id={`skill-${item.id}-enable`}
              label={`Enable ${item.name}`}
              description={`Enable the ${item.name} skill`}
              variant="default"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide "
              disabled={isToggling}
              testId={`skill-action-enable-${item.id}`}
              onActivate={() => onEnable(item.id, item.name)}
            >
              {isToggling
                ? t("skillsview.updating", { defaultValue: "Updating..." })
                : t("skillsview.Enable", { defaultValue: "Enable" })}
            </MarketplaceActionButton>
            <MarketplaceActionButton
              id={`skill-${item.id}-copy`}
              label={`Copy ${item.name} SKILL.md`}
              description={`Copy the SKILL.md source for ${item.name}`}
              variant="ghost"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide"
              disabled={isCopying}
              testId={`skill-action-copy-${item.id}`}
              onActivate={() => onCopy(item.id, item.name)}
            >
              {isCopying
                ? t("skillsview.copying", { defaultValue: "Copying..." })
                : t("skillsview.copySkillMd", {
                    defaultValue: "Copy SKILL.md",
                  })}
            </MarketplaceActionButton>
            <MarketplaceActionButton
              id={`skill-${item.id}-details`}
              label={`${item.name} details`}
              description={`Show details for ${item.name}`}
              variant="ghost"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide"
              testId={`skill-action-details-${item.id}`}
              onActivate={() => onDetails(item.id)}
            >
              {t("skillsview.details", { defaultValue: "Details" })}
            </MarketplaceActionButton>
            <MarketplaceActionButton
              id={`skill-${item.id}-uninstall`}
              label={`Uninstall ${item.name}`}
              description={`Uninstall the ${item.name} skill`}
              variant="destructive"
              className="h-8 px-3 text-xs-tight font-bold tracking-wide "
              disabled={isUninstalling}
              testId={`skill-action-uninstall-${item.id}`}
              onActivate={() => onUninstall(item.id, item.name)}
            >
              {isUninstalling
                ? t("skillsview.removing", { defaultValue: "Removing..." })
                : t("common.uninstall", { defaultValue: "Uninstall" })}
            </MarketplaceActionButton>
          </>
        )}
      </div>
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
  enableSkill,
  disableSkill,
  copySkillSource,
  showSkillDetails,
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
  enableSkill: (skillId: string, name: string) => Promise<void>;
  disableSkill: (skillId: string, name: string) => Promise<void>;
  copySkillSource: (skillId: string, name: string) => Promise<void>;
  showSkillDetails: (skillId: string) => void;
  setState: ReturnType<typeof useApp>["setState"];
  onClose: () => void;
}) {
  const t = useAppSelector((s) => s.t);
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
          {installTabs.map((installTab) => (
            <InstallSourceTab
              key={installTab.id}
              id={installTab.id}
              label={installTab.label}
              active={tab === installTab.id}
              onSelect={setTab}
            />
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
                <SkillSearchField
                  value={skillsMarketplaceQuery}
                  placeholder={t("skillsview.searchByKeyword")}
                  ariaLabel={t("skillsview.searchByKeyword", {
                    defaultValue: "Search skills marketplace",
                  })}
                  onChange={(next) => setState("skillsMarketplaceQuery", next)}
                  onSubmit={() => void searchSkillsMarketplace()}
                />
                <SkillInstallSubmitButton
                  id="skill-install-search-submit"
                  label="Search skills"
                  description="Search the skills marketplace"
                  disabled={skillsMarketplaceLoading}
                  onActivate={() => void searchSkillsMarketplace()}
                >
                  {skillsMarketplaceLoading
                    ? t("common.searching", {
                        defaultValue: "Searching...",
                      })
                    : t("common.search", { defaultValue: "Search" })}
                </SkillInstallSubmitButton>
              </div>

              {skillsMarketplaceError && (
                <div
                  role="alert"
                  className="mb-3 rounded-sm border border-danger/35 bg-danger/10 p-2.5 text-xs text-danger"
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
                  {skillsMarketplaceResults.map((item) => {
                    const installedSkill =
                      skills.find((s) => s.id === item.id) ?? null;
                    return (
                      <MarketplaceCard
                        key={item.id}
                        item={item}
                        installedSkill={installedSkill}
                        skillsMarketplaceAction={skillsMarketplaceAction}
                        onInstall={installSkillFromMarketplace}
                        onUninstall={uninstallMarketplaceSkill}
                        onEnable={enableSkill}
                        onDisable={disableSkill}
                        onCopy={copySkillSource}
                        onDetails={showSkillDetails}
                      />
                    );
                  })}
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
                <SkillUrlField
                  value={skillsMarketplaceManualGithubUrl}
                  ariaLabel={t("skillsview.githubRepositoryUrl", {
                    defaultValue: "GitHub Repository URL",
                  })}
                  onChange={(next) =>
                    setState("skillsMarketplaceManualGithubUrl", next)
                  }
                  onSubmit={() => void installSkillFromGithubUrl()}
                />
                <SkillInstallSubmitButton
                  id="skill-install-url-submit"
                  label="Install from GitHub URL"
                  description="Install a skill from the entered GitHub repository URL"
                  disabled={
                    skillsMarketplaceAction === "install:manual" ||
                    !skillsMarketplaceManualGithubUrl.trim()
                  }
                  onActivate={() => void installSkillFromGithubUrl()}
                >
                  {skillsMarketplaceAction === "install:manual"
                    ? t("common.installing", {
                        defaultValue: "Installing...",
                      })
                    : t("common.install")}
                </SkillInstallSubmitButton>
              </div>

              {skillsMarketplaceError && (
                <div
                  role="alert"
                  className="mt-3 rounded-sm border border-danger/35 bg-danger/10 p-2.5 text-xs text-danger"
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
