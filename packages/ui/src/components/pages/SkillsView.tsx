import { Brain, Plus, RefreshCw, Sparkles, Store } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import type { SkillInfo } from "../../api";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useApp } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarHeader } from "../composites/sidebar/sidebar-header";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { SkillSidebarItem } from "../composites/skills/skill-sidebar-item";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import { ConfirmDelete } from "../ui/confirm-delete";
import { Input } from "../ui/input";
import { StatusBadge } from "../ui/status-badge";
import { Switch } from "../ui/switch";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { EditSkillModal, SkillsModalView } from "./skill-detail-panel";
import { InstallModal } from "./skill-marketplace";

/* ── Agent-controllable child controls (hooks must stay at top level) ── */

function SkillFilterTab({
  tabKey,
  label,
  isActive,
  onSelect,
}: {
  tabKey: string;
  label: string;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `filter-${tabKey}`,
    role: "tab",
    label,
    group: "skills-filter",
    status: isActive ? "active" : "inactive",
    description: `Filter the skills list to ${label}`,
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      type="button"
      aria-current={isActive ? "true" : undefined}
      className={`h-8 rounded-full border px-3 text-2xs font-bold tracking-[0.14em] ${
        isActive
          ? "border-accent/30 bg-accent/10 text-txt"
          : "border-border/45 text-muted hover:border-border/70 hover:bg-bg/35 hover:text-txt"
      }`}
      onClick={onSelect}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function SkillRowButton({
  skill,
  active,
  enabled,
  icon,
  description,
  onLabel,
  offLabel,
  attentionLabel,
  onSelect,
}: {
  skill: SkillInfo;
  active: boolean;
  enabled: boolean;
  icon: string;
  description: string;
  onLabel: string;
  offLabel: string;
  attentionLabel?: string;
  onSelect: () => void;
}) {
  const { agentProps } = useAgentElement<HTMLDivElement>({
    id: `skill-${skill.id}`,
    role: "button",
    label: skill.name,
    group: "skills-list",
    status: active ? "active" : enabled ? "enabled" : "disabled",
    description: `Select the ${skill.name} skill`,
    onActivate: onSelect,
  });
  return (
    <div {...agentProps}>
      <SkillSidebarItem
        active={active}
        testId={`skill-row-${skill.id}`}
        enabled={enabled}
        icon={icon}
        name={skill.name}
        description={description}
        onLabel={onLabel}
        offLabel={offLabel}
        onSelect={onSelect}
        attentionLabel={attentionLabel}
      />
    </div>
  );
}

/* ── Main Skills View ───────────────────────────────────────────────── */

export function SkillsView({
  contentHeader,
  inModal,
}: {
  contentHeader?: ReactNode;
  inModal?: boolean;
} = {}) {
  if (inModal) return <SkillsModalView />;
  return <SkillsFullView contentHeader={contentHeader} />;
}

/* ── Full-Page Skills View ─────────────────────────────────────────── */

function SkillsFullView({ contentHeader }: { contentHeader?: ReactNode } = {}) {
  const {
    skills,
    skillCreateFormOpen,
    skillCreateName,
    skillCreateDescription,
    skillCreating,
    skillReviewReport,
    skillReviewId,
    skillReviewLoading,
    skillToggleAction,
    skillsMarketplaceQuery,
    skillsMarketplaceResults,
    skillsMarketplaceError,
    skillsMarketplaceLoading,
    skillsMarketplaceAction,
    skillsMarketplaceManualGithubUrl,
    loadSkills,
    refreshSkills,
    handleSkillToggle,
    handleCreateSkill,
    handleDeleteSkill,
    handleReviewSkill,
    handleAcknowledgeSkill,
    searchSkillsMarketplace,
    installSkillFromMarketplace,
    uninstallMarketplaceSkill,
    installSkillFromGithubUrl,
    enableMarketplaceSkill,
    disableMarketplaceSkill,
    copyMarketplaceSkillSource,
    setState,
    t,
  } = useApp();

  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "on" | "off" | "binance">(
    "all",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const filteredSkills = useMemo(() => {
    const query = filterText.toLowerCase();

    return skills.filter((skill) => {
      if (filterTab === "on" && !skill.enabled) return false;
      if (filterTab === "off" && skill.enabled) return false;
      if (filterTab === "binance" && !BINANCE_SKILL_IDS.has(skill.id))
        return false;
      if (
        query &&
        !skill.name.toLowerCase().includes(query) &&
        !skill.description?.toLowerCase().includes(query)
      ) {
        return false;
      }
      return true;
    });
  }, [skills, filterText, filterTab]);

  const selectedSkillId =
    selectedId && filteredSkills.some((skill) => skill.id === selectedId)
      ? selectedId
      : (filteredSkills[0]?.id ?? null);
  const selectedSkill = selectedSkillId
    ? (skills.find((skill) => skill.id === selectedSkillId) ?? null)
    : null;

  const filterTabs: { key: typeof filterTab; label: string }[] = [
    {
      key: "all",
      label: `${t("common.all", { defaultValue: "All" })} (${skills.length})`,
    },
    {
      key: "on",
      label: `${t("common.on")} (${skills.filter((skill) => skill.enabled).length})`,
    },
    {
      key: "off",
      label: `${t("common.off")} (${skills.filter((skill) => !skill.enabled).length})`,
    },
  ];

  const handleDismissReview = () => {
    setState("skillReviewId", "");
    setState("skillReviewReport", null);
  };

  const handleCancelCreate = () => {
    setState("skillCreateFormOpen", false);
    setState("skillCreateName", "");
    setState("skillCreateDescription", "");
  };

  const selectedSkillReviewOpen = skillReviewId === selectedSkill?.id;
  const selectedNeedsAttention =
    selectedSkill?.scanStatus === "warning" ||
    selectedSkill?.scanStatus === "critical" ||
    selectedSkill?.scanStatus === "blocked";

  const filterSearch = useAgentElement<HTMLInputElement>({
    id: "filter-search",
    role: "text-input",
    label: t("skillsview.filterSkills", { defaultValue: "Filter skills" }),
    group: "skills-toolbar",
    description: "Filter the skills list by name or description",
    getValue: () => filterText,
    onFill: (value) => setFilterText(value),
  });

  const newSkillButton = useAgentElement<HTMLButtonElement>({
    id: "new-skill",
    role: "button",
    label: skillCreateFormOpen
      ? t("common.cancel")
      : t("skillsview.NewSkill", { defaultValue: "New Skill" }),
    group: "skills-toolbar",
    status: skillCreateFormOpen ? "active" : "inactive",
    description: "Open or close the new skill builder form",
    onActivate: () => {
      setState("skillCreateFormOpen", !skillCreateFormOpen);
      if (skillCreateFormOpen) handleCancelCreate();
    },
  });

  const installButton = useAgentElement<HTMLButtonElement>({
    id: "install-skill",
    role: "button",
    label: t("common.install", { defaultValue: "Install" }),
    group: "skills-toolbar",
    description: "Open the skill marketplace install dialog",
    onActivate: () => setInstallModalOpen(true),
  });

  const refreshButton = useAgentElement<HTMLButtonElement>({
    id: "refresh-skills",
    role: "button",
    label: t("skillsview.RefreshSkillsList", {
      defaultValue: "Refresh Skills List",
    }),
    group: "skills-toolbar",
    description: "Reload the installed skills list",
    onActivate: () => void refreshSkills(),
  });

  const createNameInput = useAgentElement<HTMLInputElement>({
    id: "create-skill-name",
    role: "text-input",
    label: t("skillsview.SkillName"),
    group: "skills-create",
    description: "Name for the new skill being created",
    getValue: () => skillCreateName,
    onFill: (value) => setState("skillCreateName", value),
  });

  const createDescriptionInput = useAgentElement<HTMLInputElement>({
    id: "create-skill-description",
    role: "text-input",
    label: t("common.description"),
    group: "skills-create",
    description: "Description for the new skill being created",
    getValue: () => skillCreateDescription,
    onFill: (value) => setState("skillCreateDescription", value),
  });

  const createSubmitButton = useAgentElement<HTMLButtonElement>({
    id: "create-skill-submit",
    role: "button",
    label: t("skillsview.createSkill", { defaultValue: "Create Skill" }),
    group: "skills-create",
    description: "Create the new skill with the entered name and description",
    onActivate: () => {
      if (skillCreateName.trim() && !skillCreating) handleCreateSkill();
    },
  });

  const toggleSelectedSwitch = useAgentElement<HTMLButtonElement>({
    id: "toggle-selected-skill",
    role: "toggle",
    label: selectedSkill
      ? `${selectedSkill.name} ${selectedSkill.enabled ? t("common.on") : t("common.off")}`
      : t("common.off"),
    group: "skills-detail",
    status: selectedSkill?.enabled ? "active" : "inactive",
    description: "Enable or disable the selected skill",
    onActivate: () => {
      if (selectedSkill) {
        handleSkillToggle(selectedSkill.id, !selectedSkill.enabled);
      }
    },
  });

  const editSourceButton = useAgentElement<HTMLButtonElement>({
    id: "edit-skill-source",
    role: "button",
    label: t("skillsview.EditSource", { defaultValue: "Edit Source" }),
    group: "skills-detail",
    description: "Open the source editor for the selected skill",
    onActivate: () => {
      if (selectedSkill) setEditingSkill(selectedSkill);
    },
  });

  const skillsSidebar = (
    <AppPageSidebar
      testId="skills-sidebar"
      collapsible
      contentIdentity="skills"
      aria-label={t("skillsview.filterSkills", {
        defaultValue: "Skills list",
      })}
      collapsedRailItems={filteredSkills.map((skill) => {
        const selected = selectedSkillId === skill.id;
        return (
          <SidebarContent.RailItem
            key={skill.id}
            aria-label={skill.name}
            title={skill.name}
            active={selected}
            indicatorTone={skill.enabled ? "accent" : undefined}
            onClick={() => {
              setSelectedId(skill.id);
              setState("skillCreateFormOpen", false);
            }}
          >
            {skill.name.charAt(0).toUpperCase()}
          </SidebarContent.RailItem>
        );
      })}
    >
      <SidebarHeader
        search={{
          value: filterText,
          onChange: (event) => setFilterText(event.target.value),
          placeholder: t("skillsview.filterSkills"),
          "aria-label": t("skillsview.filterSkills"),
          onClear: () => setFilterText(""),
          ...filterSearch.agentProps,
        }}
      />
      <SidebarScrollRegion>
        <SidebarPanel>
          <SidebarContent.Toolbar className="mb-3">
            <SidebarContent.ToolbarPrimary>
              <Button
                ref={newSkillButton.ref}
                variant={skillCreateFormOpen ? "outline" : "default"}
                size="sm"
                type="button"
                className={`h-9 w-full rounded-full px-4 text-xs-tight font-bold tracking-[0.12em] ${
                  skillCreateFormOpen
                    ? "border-border/50 bg-bg/25 text-txt"
                    : "text-txt-strong"
                }`}
                onClick={() => {
                  setState("skillCreateFormOpen", !skillCreateFormOpen);
                  if (skillCreateFormOpen) {
                    handleCancelCreate();
                  }
                }}
                {...newSkillButton.agentProps}
              >
                {skillCreateFormOpen
                  ? t("common.cancel")
                  : `+ ${t("skillsview.NewSkill", { defaultValue: "New Skill" })}`}
              </Button>
            </SidebarContent.ToolbarPrimary>
            <SidebarContent.ToolbarActions>
              <Button
                ref={installButton.ref}
                variant="outline"
                size="sm"
                type="button"
                className="h-9 rounded-full px-4 text-xs-tight font-bold tracking-[0.12em]"
                onClick={() => setInstallModalOpen(true)}
                {...installButton.agentProps}
              >
                {t("common.install", { defaultValue: "Install" })}
              </Button>
              <Button
                ref={refreshButton.ref}
                variant="ghost"
                size="icon"
                type="button"
                className="h-9 w-9 rounded-full text-muted hover:text-txt"
                onClick={() => void refreshSkills()}
                title={t("skillsview.RefreshSkillsList", {
                  defaultValue: "Refresh Skills List",
                })}
                aria-label={t("skillsview.RefreshSkillsList", {
                  defaultValue: "Refresh Skills List",
                })}
                {...refreshButton.agentProps}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </SidebarContent.ToolbarActions>
          </SidebarContent.Toolbar>

          <div className="mb-3 flex flex-wrap gap-2">
            {filterTabs.map((tab) => (
              <SkillFilterTab
                key={tab.key}
                tabKey={tab.key}
                label={tab.label}
                isActive={filterTab === tab.key}
                onSelect={() => setFilterTab(tab.key)}
              />
            ))}
          </div>

          {filteredSkills.length === 0 ? (
            <SidebarContent.EmptyState>
              {skills.length === 0
                ? t("skillsview.noSkillsInstalled", {
                    defaultValue: "No Skills Installed",
                  })
                : t("skillsview.noSkillsMatchFilter", {
                    defaultValue: 'No skills match "{{filter}}"',
                    filter: filterText,
                  })}
            </SidebarContent.EmptyState>
          ) : (
            <div className="space-y-1.5">
              {filteredSkills.map((skill) => {
                const needsAttention =
                  skill.scanStatus === "warning" ||
                  skill.scanStatus === "critical" ||
                  skill.scanStatus === "blocked";
                const selected = selectedSkillId === skill.id;

                return (
                  <SkillRowButton
                    key={skill.id}
                    skill={skill}
                    active={selected}
                    enabled={skill.enabled}
                    icon={skill.name.charAt(0).toUpperCase()}
                    description={
                      skill.description || t("skillsview.noDescription")
                    }
                    onLabel={t("common.on")}
                    offLabel={t("common.off")}
                    onSelect={() => {
                      setSelectedId(skill.id);
                      setState("skillCreateFormOpen", false);
                    }}
                    attentionLabel={
                      needsAttention
                        ? skill.scanStatus === "blocked"
                          ? t("skillsview.statusBlocked")
                          : t("skillsview.statusWarning")
                        : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  );

  return (
    <ShellViewAgentSurface viewId="skills">
      <PageLayout
        data-testid="skills-shell"
        sidebar={skillsSidebar}
        contentHeader={contentHeader}
        contentInnerClassName="mx-auto w-full max-w-[76rem]"
      >
        <div data-testid="skills-detail">
          <PagePanel variant="section">
            <PagePanel.Header
              eyebrow={t("nav.advanced")}
              heading={t("advancedpageview.Skills", {
                defaultValue: "Skills",
              })}
              description={t("advancedpageview.SkillsDescription", {
                defaultValue: "Custom agent skills",
              })}
              className="border-border/35"
              actions={
                <PagePanel.Meta className="border-border/45 px-2.5 py-1 font-bold tracking-[0.16em] text-muted">
                  {t("skillsview.VisibleCount", {
                    defaultValue: "{{count}} shown",
                    count: filteredSkills.length,
                  })}
                </PagePanel.Meta>
              }
            />

            <div className="bg-bg/18 px-4 py-4 sm:px-5">
              {skills.length === 0 && !skillCreateFormOpen ? (
                <PagePanel
                  data-testid="skills-empty-state"
                  variant="surface"
                  className="grid min-h-[20rem] place-items-center rounded-sm px-6 py-10"
                >
                  <div className="w-full max-w-2xl text-center">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-sm border border-accent/25 bg-accent/12 text-accent">
                      <Brain className="h-7 w-7" />
                    </div>
                    <h2 className="mt-4 text-base font-semibold text-txt">
                      {t("skillsview.noSkillsInstalled", {
                        defaultValue: "No Skills Installed",
                      })}
                    </h2>
                    <div className="mt-5 grid gap-2 sm:grid-cols-3">
                      {[
                        { label: "Install", icon: Store, tone: "text-info" },
                        { label: "Create", icon: Plus, tone: "text-ok" },
                        {
                          label: "Review",
                          icon: Sparkles,
                          tone: "text-warning",
                        },
                      ].map((item) => {
                        const Icon = item.icon;
                        return (
                          <div
                            key={item.label}
                            className="rounded-sm border border-border/24 bg-bg/45 px-3 py-3"
                          >
                            <Icon className={`mx-auto h-4 w-4 ${item.tone}`} />
                            <div className="mt-2 text-xs font-semibold text-muted">
                              {item.label}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex w-full flex-col justify-center gap-2 sm:w-auto sm:flex-row sm:gap-3">
                      <Button
                        variant="default"
                        size="sm"
                        className="mt-5 h-10 w-full justify-center rounded-full px-5 font-bold tracking-[0.12em] sm:w-auto"
                        onClick={() => setInstallModalOpen(true)}
                      >
                        <Store className="mr-2 h-4 w-4" />
                        {t("skillsview.BrowseMarketplace")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-0 h-10 w-full justify-center rounded-full px-5 font-bold tracking-[0.12em] sm:mt-5 sm:w-auto"
                        onClick={() => setState("skillCreateFormOpen", true)}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        {t("skillsview.createSkill", {
                          defaultValue: "Create Skill",
                        })}
                      </Button>
                    </div>
                  </div>
                </PagePanel>
              ) : filteredSkills.length === 0 && !skillCreateFormOpen ? (
                <PagePanel.Empty
                  data-testid="skills-filter-empty"
                  variant="surface"
                  className="min-h-[16rem] rounded-sm px-6 py-12"
                  title={t("skillsview.noMatchingSkills", {
                    defaultValue: "No matching skills",
                  })}
                  description={t("skillsview.noSkillsMatchFilter", {
                    defaultValue: 'No skills match "{{filter}}"',
                    filter: filterText,
                  })}
                />
              ) : skillCreateFormOpen ? (
                <PagePanel variant="surface" className="overflow-hidden">
                  <PagePanel.Header
                    eyebrow={t("skillsview.skillBuilder", {
                      defaultValue: "Skill Builder",
                    })}
                    heading={t("skillsview.CreateNewSkill")}
                  />
                  <div className="bg-bg/18 px-4 py-4 sm:px-5">
                    <div className="flex flex-col gap-3">
                      <div>
                        <span className="mb-1 block text-xs-tight font-medium text-muted">
                          {t("skillsview.SkillName")}{" "}
                          <span className="text-danger">*</span>
                        </span>
                        <Input
                          ref={createNameInput.ref}
                          className="w-full border-border/50 bg-bg/50 focus-visible:ring-accent"
                          placeholder={t("skillsview.eGMyAwesomeSkil")}
                          value={skillCreateName}
                          onChange={(event) =>
                            setState("skillCreateName", event.target.value)
                          }
                          {...createNameInput.agentProps}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              skillCreateName.trim() &&
                              !skillCreating
                            ) {
                              handleCreateSkill();
                            }
                          }}
                        />
                      </div>
                      <div>
                        <span className="mb-1 block text-xs-tight font-medium text-muted">
                          {t("common.description")}
                        </span>
                        <Input
                          ref={createDescriptionInput.ref}
                          className="w-full border-border/50 bg-bg/50 focus-visible:ring-accent"
                          placeholder={t("skillsview.BriefDescriptionOf")}
                          value={skillCreateDescription}
                          onChange={(event) =>
                            setState(
                              "skillCreateDescription",
                              event.target.value,
                            )
                          }
                          {...createDescriptionInput.agentProps}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              skillCreateName.trim() &&
                              !skillCreating
                            ) {
                              handleCreateSkill();
                            }
                          }}
                        />
                      </div>
                      <div className="flex justify-end gap-2 pt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleCancelCreate}
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          ref={createSubmitButton.ref}
                          variant="default"
                          size="sm"
                          onClick={handleCreateSkill}
                          disabled={!skillCreateName.trim() || skillCreating}
                          {...createSubmitButton.agentProps}
                        >
                          {skillCreating
                            ? t("skillsview.creating", {
                                defaultValue: "Creating...",
                              })
                            : t("skillsview.createSkill", {
                                defaultValue: "Create Skill",
                              })}
                        </Button>
                      </div>
                    </div>
                  </div>
                </PagePanel>
              ) : selectedSkill ? (
                <PagePanel
                  variant="surface"
                  className="overflow-hidden"
                  data-skill-id={selectedSkill.id}
                >
                  <div className="flex items-start gap-3 px-4 py-4 sm:px-5">
                    <div className="mt-0.5 shrink-0">
                      <div className="flex h-11 w-11 items-center justify-center rounded-sm border border-accent/30 bg-accent/18 p-2.5 text-base font-bold text-txt-strong">
                        {selectedSkill.name.charAt(0).toUpperCase()}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div
                          data-testid="skills-detail-name"
                          className="whitespace-normal break-words [overflow-wrap:anywhere] text-sm font-semibold leading-snug text-txt"
                        >
                          {selectedSkill.name}
                        </div>
                        <StatusBadge
                          label={
                            selectedSkill.scanStatus === "blocked" ||
                            selectedSkill.scanStatus === "critical"
                              ? t("skillsview.statusBlocked")
                              : selectedSkill.scanStatus === "warning"
                                ? t("skillsview.statusWarning")
                                : selectedSkill.enabled
                                  ? t("common.active")
                                  : t("common.inactive")
                          }
                          variant={
                            selectedSkill.scanStatus === "warning"
                              ? "warning"
                              : selectedSkill.scanStatus === "blocked" ||
                                  selectedSkill.scanStatus === "critical"
                                ? "danger"
                                : selectedSkill.enabled
                                  ? "success"
                                  : "muted"
                          }
                          withDot
                        />
                        <span className="min-w-0 break-all text-xs-tight font-mono text-muted/80">
                          {selectedSkill.id}
                        </span>
                      </div>
                      <div className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
                        {selectedSkill.description ||
                          t("skillsview.noDescriptionProvided", {
                            defaultValue: "No description provided.",
                          })}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {selectedNeedsAttention && !selectedSkillReviewOpen && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto rounded-full border-warn/35 bg-warn/12 px-3 py-1.5 text-2xs font-bold tracking-[0.14em] text-warn"
                          onClick={() => handleReviewSkill(selectedSkill.id)}
                        >
                          {t("skillsview.ReviewFindings")}
                        </Button>
                      )}
                      {selectedNeedsAttention && selectedSkillReviewOpen && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto rounded-full border-border/50 px-3 py-1.5 text-xs-tight font-semibold text-muted hover:text-txt"
                          onClick={handleDismissReview}
                        >
                          {t("common.dismiss")}
                        </Button>
                      )}
                      <Switch
                        ref={toggleSelectedSwitch.ref}
                        checked={selectedSkill.enabled}
                        disabled={skillToggleAction === selectedSkill.id}
                        onCheckedChange={(next: boolean | "indeterminate") =>
                          handleSkillToggle(selectedSkill.id, next === true)
                        }
                        {...toggleSelectedSwitch.agentProps}
                      />
                    </div>
                  </div>
                  <div className="bg-bg/18 px-4 py-4 sm:px-5">
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <Button
                        ref={editSourceButton.ref}
                        variant="outline"
                        size="sm"
                        className="h-9 rounded-full px-4 text-xs-tight font-bold tracking-[0.12em]"
                        onClick={() => setEditingSkill(selectedSkill)}
                        {...editSourceButton.agentProps}
                      >
                        {t("skillsview.EditSource", {
                          defaultValue: "Edit Source",
                        })}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        className="h-9 w-9 rounded-full text-muted hover:text-txt"
                        onClick={() => void refreshSkills()}
                        title={t("common.refresh")}
                        aria-label={t("common.refresh")}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <ConfirmDelete
                        triggerClassName="h-9 rounded-full px-4 text-xs-tight font-bold tracking-[0.12em] !bg-transparent text-danger hover:!bg-danger/15 hover:text-danger-foreground transition-colors border border-danger/30"
                        confirmClassName="px-3 py-1 text-xs-tight font-bold bg-danger text-danger-foreground hover:bg-danger/90 transition-colors rounded-sm "
                        cancelClassName="px-3 py-1 text-xs-tight font-bold text-muted border border-border/40 hover:text-txt transition-colors rounded-sm"
                        confirmLabel={t("common.yes")}
                        cancelLabel={t("common.no")}
                        onConfirm={() =>
                          handleDeleteSkill(
                            selectedSkill.id,
                            selectedSkill.name,
                          )
                        }
                      />
                    </div>

                    {selectedSkillReviewOpen && skillReviewReport ? (
                      <PagePanel variant="inset" className="p-4 sm:p-5">
                        <div className="mb-3 flex flex-wrap items-center gap-3">
                          <span className="text-xs font-semibold text-txt">
                            {t("skillsview.ScanReport")}
                          </span>
                          <span className="text-xs-tight font-mono text-danger">
                            {skillReviewReport.summary.critical}{" "}
                            {t("skillsview.critical")}
                          </span>
                          <span className="text-xs-tight font-mono text-warn">
                            {skillReviewReport.summary.warn}{" "}
                            {t("skillsview.warnings")}
                          </span>
                        </div>
                        {skillReviewReport.findings.length > 0 && (
                          <div className="custom-scrollbar max-h-64 overflow-y-auto rounded-sm border border-border/35 bg-card/30">
                            {skillReviewReport.findings.map((finding, _idx) => (
                              <div
                                key={`${finding.file}:${finding.line}:${finding.message}`}
                                className={`flex flex-col gap-1 px-3 py-2 text-xs-tight sm:flex-row sm:items-start sm:gap-2`}
                              >
                                <span
                                  className={`shrink-0 rounded-full px-2 py-0.5 text-3xs font-bold uppercase tracking-[0.12em] ${
                                    finding.severity === "critical"
                                      ? "bg-danger/12 text-danger"
                                      : "bg-warn/12 text-warn"
                                  }`}
                                >
                                  {finding.severity === "critical"
                                    ? t("skillsview.critical")
                                    : t("skillsview.statusWarning")}
                                </span>
                                <span className="min-w-0 flex-1 text-txt">
                                  {finding.message}
                                </span>
                                <span className="min-w-0 break-all font-mono text-muted sm:shrink-0">
                                  {finding.file}:{finding.line}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="mt-4 flex gap-2">
                          <Button
                            variant="default"
                            size="sm"
                            className="h-9 rounded-full px-4 text-xs-tight font-bold tracking-[0.12em]"
                            onClick={() =>
                              handleAcknowledgeSkill(selectedSkill.id)
                            }
                          >
                            {t("skillsview.AcknowledgeAmpEn")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 rounded-full px-4 text-xs-tight font-bold tracking-[0.12em] text-muted hover:text-txt"
                            onClick={handleDismissReview}
                          >
                            {t("common.dismiss")}
                          </Button>
                        </div>
                      </PagePanel>
                    ) : selectedSkillReviewOpen && skillReviewLoading ? (
                      <PagePanel.Notice tone="accent">
                        {t("skillsview.LoadingScanReport")}
                      </PagePanel.Notice>
                    ) : (
                      <PagePanel variant="inset" className="p-4 sm:p-5">
                        <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted/60">
                          {t("skillsview.EditSource", {
                            defaultValue: "Edit Source",
                          })}
                        </div>
                        <div className="mt-2 text-sm leading-relaxed text-muted">
                          {t("skillsview.SkillSourceEditorDescription", {
                            defaultValue:
                              "Open the skill source editor to inspect or modify `SKILL.md`, or review findings here when a skill needs attention.",
                          })}
                        </div>
                      </PagePanel>
                    )}
                  </div>
                </PagePanel>
              ) : (
                <PagePanel.Empty
                  variant="surface"
                  className="min-h-[16rem] rounded-sm px-6 py-12"
                  title={t("skillsview.SelectATalentToConf", {
                    defaultValue: "Select a talent to configure",
                  })}
                />
              )}
            </div>
          </PagePanel>
        </div>
      </PageLayout>
      {editingSkill && (
        <EditSkillModal
          skillId={editingSkill.id}
          skillName={editingSkill.name}
          onClose={() => setEditingSkill(null)}
          onSaved={() => void refreshSkills()}
        />
      )}
      {installModalOpen && (
        <InstallModal
          skills={skills}
          skillsMarketplaceQuery={skillsMarketplaceQuery}
          skillsMarketplaceResults={skillsMarketplaceResults}
          skillsMarketplaceError={skillsMarketplaceError}
          skillsMarketplaceLoading={skillsMarketplaceLoading}
          skillsMarketplaceAction={skillsMarketplaceAction}
          skillsMarketplaceManualGithubUrl={skillsMarketplaceManualGithubUrl}
          searchSkillsMarketplace={searchSkillsMarketplace}
          installSkillFromMarketplace={installSkillFromMarketplace}
          uninstallMarketplaceSkill={uninstallMarketplaceSkill}
          installSkillFromGithubUrl={installSkillFromGithubUrl}
          enableSkill={enableMarketplaceSkill}
          disableSkill={disableMarketplaceSkill}
          copySkillSource={copyMarketplaceSkillSource}
          showSkillDetails={(skillId) => {
            setSelectedId(skillId);
            setInstallModalOpen(false);
          }}
          setState={setState}
          onClose={() => setInstallModalOpen(false)}
        />
      )}
    </ShellViewAgentSurface>
  );
}

const BINANCE_SKILL_IDS = new Set([
  "binance-crypto-market-rank",
  "binance-meme-rush",
  "binance-query-address-info",
  "binance-query-token-audit",
  "binance-query-token-info",
  "binance-trading-signal",
]);
