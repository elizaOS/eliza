/**
 * The Skills view (`/skills`): browses the agent's installed runtime skills and
 * installs new ones directly from GitHub. Renders a full-page layout or a
 * compact modal variant depending on the `inModal` prop. Skill data and
 * install/create mutations come from the app store; tiles register with the
 * agent surface via `useAgentElement`.
 */
import { Brain } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import type { SkillInfo } from "../../api";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { WorkspaceLayout } from "../../layouts/workspace-layout";
import { useAppSelectorShallow } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { PagePanel } from "../composites/page-panel";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
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
import { InstallModal } from "./skill-installer";

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
      variant="selection"
      size="badge"
      data-state={isActive ? "on" : "off"}
      type="button"
      aria-pressed={isActive}
      onClick={onSelect}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

const SkillRowButton = memo(function SkillRowButton({
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
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `skill-${skill.id}`,
    role: "button",
    label: skill.name,
    group: "skills-list",
    status: active ? "active" : enabled ? "enabled" : "disabled",
    description: `Select the ${skill.name} skill`,
    onActivate: onSelect,
  });
  return (
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
      buttonProps={agentProps}
      buttonRef={ref}
    />
  );
});

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
  return (
    <ShellViewAgentSurface viewId="skills">
      <SkillsFullViewContent contentHeader={contentHeader} />
    </ShellViewAgentSurface>
  );
}

function SkillsFullViewContent({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const isWideSkillsWorkspace = useMediaQuery(
    "(min-width: 820px) and (min-height: 600px)",
  );
  const isShortViewport = useMediaQuery("(max-height: 480px)");
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
    skillInstallError,
    skillInstallAction,
    skillInstallGithubUrl,
    loadSkills,
    refreshSkills,
    handleSkillToggle,
    handleCreateSkill,
    handleDeleteSkill,
    handleReviewSkill,
    handleAcknowledgeSkill,
    installSkillFromGithubUrl,
    setState,
    t,
  } = useAppSelectorShallow((s) => ({
    skills: s.skills,
    skillCreateFormOpen: s.skillCreateFormOpen,
    skillCreateName: s.skillCreateName,
    skillCreateDescription: s.skillCreateDescription,
    skillCreating: s.skillCreating,
    skillReviewReport: s.skillReviewReport,
    skillReviewId: s.skillReviewId,
    skillReviewLoading: s.skillReviewLoading,
    skillToggleAction: s.skillToggleAction,
    skillInstallError: s.skillInstallError,
    skillInstallAction: s.skillInstallAction,
    skillInstallGithubUrl: s.skillInstallGithubUrl,
    loadSkills: s.loadSkills,
    refreshSkills: s.refreshSkills,
    handleSkillToggle: s.handleSkillToggle,
    handleCreateSkill: s.handleCreateSkill,
    handleDeleteSkill: s.handleDeleteSkill,
    handleReviewSkill: s.handleReviewSkill,
    handleAcknowledgeSkill: s.handleAcknowledgeSkill,
    installSkillFromGithubUrl: s.installSkillFromGithubUrl,
    setState: s.setState,
    t: s.t,
  }));

  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "on" | "off" | "binance">(
    "all",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);

  // The floating chat composer is this view's search box. While Skills is the
  // active view it takes over the composer (placeholder + live draft) and feeds
  // each keystroke into the `filterText` filter — there's no in-page search input.
  const searchPlaceholder = t("skillsview.SearchSkills", {
    defaultValue: "Search skills…",
  });
  const chatBinding = useMemo(
    () => ({ placeholder: searchPlaceholder, onQuery: setFilterText }),
    [searchPlaceholder],
  );
  useRegisterViewChatBinding(chatBinding);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  // The skills list polls itself in the background instead of exposing a manual
  // refresh control — silently revalidate on a slow interval and on window focus.
  // The interval is gated on document visibility so a backgrounded window goes
  // quiet; the focus listener still gives an immediate refresh on return.
  useEffect(() => {
    const poll = () => void refreshSkills();
    window.addEventListener("focus", poll);
    return () => {
      window.removeEventListener("focus", poll);
    };
  }, [refreshSkills]);
  useIntervalWhenDocumentVisible(() => void refreshSkills(), 20_000);

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

  const enabledSkillCount = useMemo(
    () => skills.filter((skill) => skill.enabled).length,
    [skills],
  );
  const disabledSkillCount = skills.length - enabledSkillCount;

  const filterTabs: { key: typeof filterTab; label: string }[] = [
    {
      key: "all",
      label: `${t("common.all", { defaultValue: "All" })} (${skills.length})`,
    },
    {
      key: "on",
      label: `${t("common.on")} (${enabledSkillCount})`,
    },
    {
      key: "off",
      label: `${t("common.off")} (${disabledSkillCount})`,
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
    description: "Open the direct GitHub skill installer",
    onActivate: () => setInstallModalOpen(true),
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

  const skillsCollectionContent = (
    <>
      {isWideSkillsWorkspace || skills.length > 0 ? (
        <SidebarContent.Toolbar className="mb-3">
          <SidebarContent.ToolbarPrimary
            className={isWideSkillsWorkspace ? "flex-none" : undefined}
          >
            <Button
              ref={newSkillButton.ref}
              variant={skillCreateFormOpen ? "outlineMuted" : "default"}
              size="pill"
              type="button"
              className={isWideSkillsWorkspace ? undefined : "w-full"}
              onClick={() => {
                setState("skillCreateFormOpen", !skillCreateFormOpen);
                if (skillCreateFormOpen) handleCancelCreate();
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
              size="pill"
              type="button"
              onClick={() => setInstallModalOpen(true)}
              {...installButton.agentProps}
            >
              {t("common.install", { defaultValue: "Install" })}
            </Button>
          </SidebarContent.ToolbarActions>
        </SidebarContent.Toolbar>
      ) : null}

      {skills.length > 0 ? (
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
      ) : null}

      {filteredSkills.length === 0 &&
      isWideSkillsWorkspace &&
      skills.length === 0 ? null : filteredSkills.length === 0 ? (
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
                description={skill.description || t("skillsview.noDescription")}
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
    </>
  );

  const skillsSidebar = !isWideSkillsWorkspace ? (
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
      <SidebarScrollRegion>
        <SidebarPanel>{skillsCollectionContent}</SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  ) : undefined;

  return (
    <>
      <WorkspaceLayout
        data-testid="skills-shell"
        sidebar={skillsSidebar}
        contentHeader={contentHeader}
        contentInnerClassName="mx-auto w-full max-w-4xl"
        headerPlacement="outside"
      >
        {isWideSkillsWorkspace ? (
          <PagePanel variant="section" className="mb-4 p-4 sm:px-5">
            {skillsCollectionContent}
          </PagePanel>
        ) : null}
        <div data-testid="skills-detail">
          <PagePanel variant="section">
            <div className="p-4 sm:px-5">
              {skills.length === 0 && !skillCreateFormOpen ? (
                <div
                  data-testid="skills-empty-state"
                  className={`flex ${isShortViewport ? "min-h-[7rem]" : "min-h-[20rem]"}`}
                >
                  <PagePanel.Empty
                    className={`flex-1 ${isShortViewport ? "min-h-[7rem] gap-2 p-2" : ""}`}
                    icon={<Brain className="size-6" aria-hidden />}
                    title={t("skillsview.noSkillsInstalled", {
                      defaultValue: "No Skills Installed",
                    })}
                    action={
                      !isWideSkillsWorkspace ? (
                        <div className="flex flex-wrap justify-center gap-2">
                          <Button
                            ref={newSkillButton.ref}
                            variant="default"
                            size="pill"
                            type="button"
                            onClick={() =>
                              setState("skillCreateFormOpen", true)
                            }
                            {...newSkillButton.agentProps}
                          >
                            {t("skillsview.NewSkill", {
                              defaultValue: "New Skill",
                            })}
                          </Button>
                          <Button
                            ref={installButton.ref}
                            variant="outline"
                            size="pill"
                            type="button"
                            onClick={() => setInstallModalOpen(true)}
                            {...installButton.agentProps}
                          >
                            {t("common.install", { defaultValue: "Install" })}
                          </Button>
                        </div>
                      ) : undefined
                    }
                  />
                </div>
              ) : filteredSkills.length === 0 && !skillCreateFormOpen ? (
                <PagePanel.Empty
                  data-testid="skills-filter-empty"
                  className="min-h-[16rem] px-6 py-12 [@media(max-height:480px)]:min-h-[9rem] [@media(max-height:480px)]:py-3"
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
                  <div className="p-4 sm:px-5">
                    <div className="flex flex-col gap-3">
                      <div>
                        <span className="mb-1 block text-xs-tight font-medium text-muted">
                          {t("skillsview.SkillName")}{" "}
                          <span className="text-danger">*</span>
                        </span>
                        <Input
                          ref={createNameInput.ref}
                          variant="form"
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
                          variant="form"
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
                  <div className="flex items-start gap-3 p-4 sm:px-5">
                    <div className="mt-0.5 shrink-0">
                      <div className="flex  size-11 items-center justify-center rounded-sm bg-accent/18 p-2.5 text-base font-bold text-txt-strong">
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
                        {selectedNeedsAttention ? (
                          <StatusBadge
                            label={
                              selectedSkill.scanStatus === "warning"
                                ? t("skillsview.statusWarning")
                                : t("skillsview.statusBlocked")
                            }
                            variant={
                              selectedSkill.scanStatus === "warning"
                                ? "warning"
                                : "danger"
                            }
                            withDot
                          />
                        ) : null}
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
                          variant="warningOutline"
                          size="badge"
                          onClick={() => handleReviewSkill(selectedSkill.id)}
                        >
                          {t("skillsview.ReviewFindings")}
                        </Button>
                      )}
                      {selectedNeedsAttention && selectedSkillReviewOpen && (
                        <Button
                          variant="outlineMuted"
                          size="badge"
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
                  <div className="p-4 sm:px-5">
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <Button
                        ref={editSourceButton.ref}
                        variant="outline"
                        size="pill"
                        onClick={() => setEditingSkill(selectedSkill)}
                        {...editSourceButton.agentProps}
                      >
                        {t("skillsview.EditSource", {
                          defaultValue: "Edit Source",
                        })}
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
                          <div className="custom-scrollbar max-h-64 overflow-y-auto">
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
                            size="pill"
                            onClick={() =>
                              handleAcknowledgeSkill(selectedSkill.id)
                            }
                          >
                            {t("skillsview.AcknowledgeAmpEn")}
                          </Button>
                          <Button
                            variant="ghostMuted"
                            size="pill"
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
                    ) : null}
                  </div>
                </PagePanel>
              ) : (
                <PagePanel.Empty
                  className="min-h-[16rem] px-6 py-12"
                  title={t("skillsview.SelectATalentToConf", {
                    defaultValue: "Select a talent to configure",
                  })}
                />
              )}
            </div>
          </PagePanel>
        </div>
      </WorkspaceLayout>
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
          githubUrl={skillInstallGithubUrl}
          error={skillInstallError}
          installing={skillInstallAction === "install:github"}
          onGithubUrlChange={(value) =>
            setState("skillInstallGithubUrl", value)
          }
          onInstall={installSkillFromGithubUrl}
          onClose={() => setInstallModalOpen(false)}
        />
      )}
    </>
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
