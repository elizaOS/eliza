import { CheckCircle2, Plus, X, XCircle } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import type { TriggerSummary } from "../../api/client";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useAppSelectorShallow } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { confirmDesktopAction } from "../../utils";
import { formatDateTime, formatDurationMs } from "../../utils/format";
import { detectUiHostCapabilities } from "../../utils/host-capabilities";
import { ChatSearchHint } from "../composites/chat-search-hint";
import { PagePanel } from "../composites/page-panel";
import { SidebarCollapsedActionButton } from "../composites/sidebar/sidebar-collapsed-rail";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import { FieldLabel } from "../ui/field";
import { NewActionButton } from "../ui/new-action-button";
import { StatusDot } from "../ui/status-badge";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { HeartbeatForm } from "./HeartbeatForm";
import {
  BUILT_IN_TEMPLATES,
  buildCreateRequest,
  buildUpdateRequest,
  emptyForm,
  formFromTrigger,
  getTemplateInstructions,
  getTemplateName,
  type HeartbeatTemplate,
  loadUserTemplates,
  localizedExecutionStatus,
  railMonogram,
  saveUserTemplates,
  scheduleLabel,
  type TriggerFormState,
  toneForLastStatus,
  validateForm,
} from "./heartbeat-utils";

// ── Long-running host banner ──────────────────────────────────────
//
// Surfaces a one-time, session-scoped warning when the user has scheduled
// triggers (cron / interval) but the current host cannot keep a process
// alive in the background (mobile without BackgroundRunner registered,
// or a plain browser tab). The banner does NOT block save / activation —
// it only sets expectations.

const LONG_RUNNING_BANNER_DISMISS_KEY = "eliza:longrunning-banner-dismissed";

function isScheduledTrigger(trigger: TriggerSummary): boolean {
  return (
    (trigger.triggerType === "cron" || trigger.triggerType === "interval") &&
    trigger.enabled
  );
}

function LongRunningHostBanner({ triggers }: { triggers: TriggerSummary[] }) {
  const host = useMemo(() => detectUiHostCapabilities(), []);
  const scheduledCount = useMemo(
    () => triggers.filter(isScheduledTrigger).length,
    [triggers],
  );

  const initialDismissed = useMemo(() => {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(LONG_RUNNING_BANNER_DISMISS_KEY) === "1";
  }, []);
  const [dismissed, setDismissed] = useState<boolean>(initialDismissed);

  if (host.longRunning || scheduledCount === 0 || dismissed) {
    return null;
  }

  const triggerWord = scheduledCount === 1 ? "trigger" : "triggers";

  return (
    <PagePanel.Notice
      tone="warning"
      role="status"
      aria-live="polite"
      className="mb-3 text-xs"
      actions={
        <Button
          variant="ghost"
          size="sm"
          className="h-auto px-0 py-0 text-xs font-medium text-muted underline-offset-2 hover:bg-transparent hover:text-txt hover:underline"
          onClick={() => {
            if (typeof sessionStorage !== "undefined") {
              sessionStorage.setItem(LONG_RUNNING_BANNER_DISMISS_KEY, "1");
            }
            setDismissed(true);
          }}
        >
          Dismiss
        </Button>
      }
    >
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">{host.label}</span>
        <span>
          You have {scheduledCount} scheduled {triggerWord}. On your current
          device, they fire only while the app is in foreground. To run reliably
          in background, pair Eliza Cloud or install on a server.
        </span>
      </div>
    </PagePanel.Notice>
  );
}

// ── View controller hook ───────────────────────────────────────────

function useHeartbeatsViewController() {
  const {
    triggers = [],
    triggersLoaded = false,
    triggersLoading = false,
    triggersSaving = false,
    triggerRunsById = {},
    triggerHealth: _triggerHealth = null,
    triggerError = null,
    loadTriggers = async () => {},
    createTrigger = async () => null,
    updateTrigger = async () => null,
    deleteTrigger = async () => true,
    runTriggerNow = async () => true,
    loadTriggerRuns = async () => {},
    loadTriggerHealth = async () => {},
    ensureTriggersLoaded = async () => {
      await loadTriggers(triggersLoaded ? { silent: true } : undefined);
    },
    t,
    uiLanguage,
  } = useAppSelectorShallow((s) => ({
    triggers: s.triggers,
    triggersLoaded: s.triggersLoaded,
    triggersLoading: s.triggersLoading,
    triggersSaving: s.triggersSaving,
    triggerRunsById: s.triggerRunsById,
    triggerHealth: s.triggerHealth,
    triggerError: s.triggerError,
    loadTriggers: s.loadTriggers,
    createTrigger: s.createTrigger,
    updateTrigger: s.updateTrigger,
    deleteTrigger: s.deleteTrigger,
    runTriggerNow: s.runTriggerNow,
    loadTriggerRuns: s.loadTriggerRuns,
    loadTriggerHealth: s.loadTriggerHealth,
    ensureTriggersLoaded: s.ensureTriggersLoaded,
    t: s.t,
    uiLanguage: s.uiLanguage,
  }));

  const [form, setForm] = useState<TriggerFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedTriggerId, setSelectedTriggerId] = useState<string | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const lastSelectedTriggerIdRef = useRef<string | null>(null);
  const [userTemplates, setUserTemplates] =
    useState<HeartbeatTemplate[]>(loadUserTemplates);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const didBootstrapDataRef = useRef(false);

  const saveFormAsTemplate = useCallback(() => {
    const name = form.displayName.trim();
    if (!name) return;
    const template: HeartbeatTemplate = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      instructions: form.instructions.trim(),
      interval: form.durationValue || "1",
      unit: form.durationUnit,
    };
    setUserTemplates((prev) => {
      const next = [...prev, template];
      saveUserTemplates(next);
      return next;
    });
  }, [form]);

  const deleteUserTemplate = useCallback((id: string) => {
    setUserTemplates((prev) => {
      const next = prev.filter((t) => t.id !== id);
      saveUserTemplates(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (didBootstrapDataRef.current) return;
    didBootstrapDataRef.current = true;
    void loadTriggerHealth();
    void ensureTriggersLoaded();
  }, [ensureTriggersLoaded, loadTriggerHealth]);

  useEffect(() => {
    if (!selectedTriggerId) return;
    if (!triggers.some((trigger) => trigger.id === selectedTriggerId)) {
      setSelectedTriggerId(null);
    }
  }, [selectedTriggerId, triggers]);

  useEffect(() => {
    if (selectedTriggerId) {
      lastSelectedTriggerIdRef.current = selectedTriggerId;
    }
  }, [selectedTriggerId]);

  useEffect(() => {
    if (editorOpen || editingId || selectedTriggerId || triggers.length === 0) {
      return;
    }

    const preferredTriggerId = lastSelectedTriggerIdRef.current;
    const nextSelectedTriggerId =
      preferredTriggerId &&
      triggers.some((trigger) => trigger.id === preferredTriggerId)
        ? preferredTriggerId
        : (triggers[0]?.id ?? null);

    if (nextSelectedTriggerId) {
      setSelectedTriggerId(nextSelectedTriggerId);
    }
  }, [editorOpen, editingId, selectedTriggerId, triggers]);

  const resolvedSelectedTrigger = useMemo(() => {
    if (editorOpen || editingId) {
      return null;
    }

    if (selectedTriggerId) {
      const selectedTrigger =
        triggers.find((trigger) => trigger.id === selectedTriggerId) ?? null;
      if (selectedTrigger) {
        return selectedTrigger;
      }
    }

    const preferredTriggerId = lastSelectedTriggerIdRef.current;
    if (preferredTriggerId) {
      const preferredTrigger =
        triggers.find((trigger) => trigger.id === preferredTriggerId) ?? null;
      if (preferredTrigger) {
        return preferredTrigger;
      }
    }

    return triggers[0] ?? null;
  }, [editorOpen, editingId, selectedTriggerId, triggers]);

  useEffect(() => {
    if (!editorOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEditorOpen(false);
        setEditingId(null);
        setForm(emptyForm);
        setFormError(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editorOpen]);

  const resetEditor = () => {
    setForm(emptyForm);
    setEditingId(null);
    setFormError(null);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    resetEditor();
  };

  const openCreateEditor = () => {
    resetEditor();
    setEditorOpen(true);
  };

  const openEditEditor = (trigger: TriggerSummary) => {
    setEditingId(trigger.id);
    setForm(formFromTrigger(trigger));
    setFormError(null);
    setSelectedTriggerId(trigger.id);
    setEditorOpen(true);
  };

  const setField = <K extends keyof TriggerFormState>(
    key: K,
    value: TriggerFormState[K],
  ) => setForm((previous) => ({ ...previous, [key]: value }));

  const onSubmit = async () => {
    const error = validateForm(form, t);
    if (error) {
      setFormError(error);
      return;
    }

    setFormError(null);

    if (editingId) {
      const updated = await updateTrigger(editingId, buildUpdateRequest(form));
      if (updated) {
        setSelectedTriggerId(updated.id);
        closeEditor();
      }
      return;
    }

    const created = await createTrigger(buildCreateRequest(form));
    if (created) {
      setSelectedTriggerId(created.id);
      void loadTriggerRuns(created.id);
      closeEditor();
    }
  };

  const onDelete = async () => {
    if (!editingId) return;
    const confirmed = await confirmDesktopAction({
      title: t("heartbeatsview.deleteTitle"),
      message: t("heartbeatsview.deleteMessage", { name: form.displayName }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      type: "warning",
    });
    if (!confirmed) return;

    const deleted = await deleteTrigger(editingId);
    if (!deleted) return;

    if (selectedTriggerId === editingId) {
      setSelectedTriggerId(null);
    }
    closeEditor();
  };

  const onRunSelectedTrigger = async (triggerId: string) => {
    setSelectedTriggerId(triggerId);
    await runTriggerNow(triggerId);
  };

  const onToggleTriggerEnabled = async (
    triggerId: string,
    currentlyEnabled: boolean,
  ) => {
    const updated = await updateTrigger(triggerId, {
      enabled: !currentlyEnabled,
    });
    if (updated && editingId === updated.id) {
      setForm(formFromTrigger(updated));
    }
  };

  const modalTitle = editingId
    ? t("heartbeatsview.editTitle", {
        name: form.displayName.trim() || t("common.heartbeat"),
      })
    : t("heartbeatsview.newHeartbeat");
  const editorEnabled =
    editingId != null
      ? (triggers.find((trigger) => trigger.id === editingId)?.enabled ??
        form.enabled)
      : form.enabled;
  const hasHeartbeats = triggers.length > 0;
  const showFirstRunEmptyState =
    !triggersLoading && !triggerError && !hasHeartbeats;
  const showDetailPane = Boolean(
    editorOpen || editingId || resolvedSelectedTrigger,
  );
  const newHeartbeatLabel = t("heartbeatsview.newHeartbeat");

  return {
    closeEditor,
    deleteUserTemplate,
    editorEnabled,
    editingId,
    editorOpen,
    form,
    formError,
    hasHeartbeats,
    loadTriggerRuns,
    modalTitle,
    newHeartbeatLabel,
    onDelete,
    onRunSelectedTrigger,
    onSubmit,
    onToggleTriggerEnabled,
    openCreateEditor,
    openEditEditor,
    saveFormAsTemplate,
    selectedTriggerId,
    setEditingId,
    setEditorOpen,
    setField,
    setForm,
    setFormError,
    setSelectedTriggerId,
    setTemplateNotice,
    showDetailPane,
    showFirstRunEmptyState,
    selectedTrigger: resolvedSelectedTrigger,
    t,
    templateNotice,
    triggers,
    triggerError,
    triggerRunsById,
    triggersLoading,
    triggersSaving,
    uiLanguage,
    userTemplates,
  };
}

type HeartbeatsViewController = ReturnType<typeof useHeartbeatsViewController>;

const HeartbeatsViewContext = createContext<HeartbeatsViewController | null>(
  null,
);

function useHeartbeatsViewContext(): HeartbeatsViewController {
  const context = useContext(HeartbeatsViewContext);
  if (!context) {
    throw new Error("Heartbeats view context is unavailable.");
  }
  return context;
}

function HeartbeatsViewProvider({ children }: { children: ReactNode }) {
  const controller = useHeartbeatsViewController();
  return (
    <HeartbeatsViewContext.Provider value={controller}>
      {children}
    </HeartbeatsViewContext.Provider>
  );
}

function HeartbeatsLayout() {
  const {
    closeEditor,
    deleteUserTemplate,
    editorEnabled,
    editingId,
    editorOpen,
    form,
    formError,
    loadTriggerRuns,
    modalTitle,
    newHeartbeatLabel,
    onDelete,
    onRunSelectedTrigger,
    onSubmit,
    onToggleTriggerEnabled,
    openCreateEditor,
    openEditEditor,
    saveFormAsTemplate,
    selectedTriggerId,
    setEditingId,
    setEditorOpen,
    setField,
    setForm,
    setFormError,
    setSelectedTriggerId,
    setTemplateNotice,
    showDetailPane,
    showFirstRunEmptyState,
    selectedTrigger,
    t,
    templateNotice,
    triggers,
    triggerError,
    triggerRunsById,
    triggersLoading,
    triggersSaving,
    uiLanguage,
    userTemplates,
  } = useHeartbeatsViewContext();
  const [searchQuery, setSearchQuery] = useState("");
  const searchLabel = t("heartbeatsview.searchHeartbeats", {
    defaultValue: "Search heartbeats",
  });
  // The floating chat composer is this view's search box. While Heartbeats is
  // the active view it takes over the composer (placeholder + live draft) and
  // feeds each keystroke into the `searchQuery` filter — no in-page search input.
  const chatBinding = useMemo(
    () => ({ placeholder: searchLabel, onQuery: setSearchQuery }),
    [searchLabel],
  );
  useRegisterViewChatBinding(chatBinding);
  const noMatchingHeartbeatsLabel = t("heartbeatsview.noMatchingHeartbeats", {
    defaultValue: "No matching heartbeats",
  });
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleTriggers = useMemo(() => {
    if (!normalizedSearchQuery) {
      return triggers;
    }

    return triggers.filter((trigger) => {
      const haystacks = [
        trigger.displayName,
        trigger.instructions,
        trigger.triggerType,
        trigger.cronExpression ?? "",
      ];
      return haystacks.some((value) =>
        value.toLowerCase().includes(normalizedSearchQuery),
      );
    });
  }, [normalizedSearchQuery, triggers]);
  const selectedRuns = selectedTrigger
    ? (triggerRunsById[selectedTrigger.id] ?? [])
    : [];
  const hasLoadedSelectedRuns =
    selectedTrigger != null &&
    Object.hasOwn(triggerRunsById, selectedTrigger.id);
  const { failureCount, successCount } = selectedRuns.reduce(
    (counts, run) => {
      const tone = toneForLastStatus(run.status);
      if (tone === "success") {
        counts.successCount += 1;
      } else if (tone === "danger") {
        counts.failureCount += 1;
      }
      return counts;
    },
    { failureCount: 0, successCount: 0 },
  );
  const selectedRunCount = selectedRuns.length;
  const mobileSidebarLabel =
    editorOpen || editingId
      ? modalTitle
      : (selectedTrigger?.displayName ??
        t("nav.heartbeats", { defaultValue: "Heartbeats" }));

  const openCreateHeartbeat = () => {
    openCreateEditor();
    setSelectedTriggerId(null);
  };

  const selectTrigger = (triggerId: string) => {
    setSelectedTriggerId(triggerId);
    setEditorOpen(false);
    setEditingId(null);
    void loadTriggerRuns(triggerId);
  };

  const newHeartbeatAgent = useAgentElement<HTMLButtonElement>({
    id: "new-heartbeat",
    role: "button",
    label: newHeartbeatLabel,
    group: "heartbeats-actions",
    description: "Create a new heartbeat",
    onActivate: openCreateHeartbeat,
  });
  const toggleEnabledAgent = useAgentElement<HTMLButtonElement>({
    id: "toggle-heartbeat-enabled",
    role: "button",
    label: selectedTrigger?.enabled ? t("common.pause") : t("common.resume"),
    group: "heartbeat-detail-actions",
    status: selectedTrigger?.enabled ? "active" : "inactive",
    description: "Pause or resume the selected heartbeat",
    onActivate: () => {
      if (selectedTrigger) {
        void onToggleTriggerEnabled(
          selectedTrigger.id,
          selectedTrigger.enabled,
        );
      }
    },
  });
  const editHeartbeatAgent = useAgentElement<HTMLButtonElement>({
    id: "edit-heartbeat",
    role: "button",
    label: t("common.edit"),
    group: "heartbeat-detail-actions",
    description: "Edit the selected heartbeat",
    onActivate: () => {
      if (selectedTrigger) openEditEditor(selectedTrigger);
    },
  });
  const duplicateHeartbeatAgent = useAgentElement<HTMLButtonElement>({
    id: "duplicate-heartbeat",
    role: "button",
    label: t("heartbeatsview.duplicate"),
    group: "heartbeat-detail-actions",
    description: "Duplicate the selected heartbeat into a new draft",
    onActivate: () => {
      if (!selectedTrigger) return;
      setForm({
        ...formFromTrigger(selectedTrigger),
        displayName: `${selectedTrigger.displayName} (copy)`,
      });
      setEditorOpen(true);
      setEditingId(null);
      setSelectedTriggerId(null);
    },
  });
  const runNowAgent = useAgentElement<HTMLButtonElement>({
    id: "run-heartbeat-now",
    role: "button",
    label: t("triggersview.RunNow"),
    group: "heartbeat-detail-actions",
    description: "Run the selected heartbeat immediately",
    onActivate: () => {
      if (selectedTrigger) void onRunSelectedTrigger(selectedTrigger.id);
    },
  });
  const refreshRunsAgent = useAgentElement<HTMLButtonElement>({
    id: "refresh-run-history",
    role: "button",
    label: t("common.refresh"),
    group: "heartbeat-detail-actions",
    description: "Refresh the run history for the selected heartbeat",
    onActivate: () => {
      if (selectedTrigger) void loadTriggerRuns(selectedTrigger.id);
    },
  });

  const heartbeatsSidebar = (
    <AppPageSidebar
      testId="heartbeats-sidebar"
      collapsible
      contentIdentity="heartbeats"
      collapseButtonTestId="heartbeats-sidebar-collapse-toggle"
      expandButtonTestId="heartbeats-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse heartbeats"
      expandButtonAriaLabel="Expand heartbeats"
      collapsedRailAction={
        <SidebarCollapsedActionButton
          aria-label={newHeartbeatLabel}
          onClick={openCreateHeartbeat}
        >
          <Plus className="h-4 w-4" />
        </SidebarCollapsedActionButton>
      }
      collapsedRailItems={visibleTriggers.map((trigger) => {
        const isActive =
          trigger.id === selectedTriggerId || trigger.id === editingId;
        return (
          <SidebarContent.RailItem
            key={trigger.id}
            aria-label={trigger.displayName}
            title={trigger.displayName}
            active={isActive}
            indicatorTone={trigger.enabled ? "accent" : undefined}
            onClick={() => selectTrigger(trigger.id)}
          >
            {railMonogram(trigger.displayName)}
          </SidebarContent.RailItem>
        );
      })}
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          <NewActionButton
            ref={newHeartbeatAgent.ref}
            className="mb-3"
            onClick={openCreateHeartbeat}
            {...newHeartbeatAgent.agentProps}
          >
            {newHeartbeatLabel}
          </NewActionButton>
          {triggerError && (
            <SidebarContent.Notice tone="danger" className="mb-1 text-xs">
              {triggerError}
            </SidebarContent.Notice>
          )}
          {triggersLoading && (
            <SidebarContent.Notice
              icon={
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
              }
            >
              {t("common.loading")}
            </SidebarContent.Notice>
          )}
          {normalizedSearchQuery &&
          visibleTriggers.length === 0 &&
          !triggersLoading ? (
            <SidebarContent.EmptyState className="px-4 py-6">
              {noMatchingHeartbeatsLabel}
            </SidebarContent.EmptyState>
          ) : (
            visibleTriggers.map((trigger) => {
              const isActive = selectedTriggerId === trigger.id;

              return (
                <SidebarContent.Item
                  key={trigger.id}
                  onClick={() => selectTrigger(trigger.id)}
                  onDoubleClick={() => {
                    openEditEditor(trigger);
                    void loadTriggerRuns(trigger.id);
                  }}
                  active={isActive}
                  className="h-auto"
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-sm font-semibold text-txt">
                        {trigger.displayName}
                      </span>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${
                          trigger.enabled ? "text-ok" : "text-muted-strong"
                        }`}
                      >
                        <StatusDot
                          tone={trigger.enabled ? "success" : "muted"}
                        />
                        {trigger.enabled
                          ? t("common.active")
                          : t("common.paused")}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-xs-tight text-muted">
                      <span className="truncate">
                        {scheduleLabel(trigger, t, uiLanguage)}
                      </span>
                      {trigger.lastStatus && (
                        <span className="inline-flex shrink-0 items-center gap-1.5">
                          <StatusDot
                            tone={toneForLastStatus(trigger.lastStatus)}
                          />
                          {localizedExecutionStatus(trigger.lastStatus, t)}
                        </span>
                      )}
                    </div>
                  </div>
                </SidebarContent.Item>
              );
            })
          )}

          <div className="mt-3 px-1 pb-1 pt-4">
            <SidebarContent.SectionHeader>
              <SidebarContent.SectionLabel>
                {t("heartbeatsview.Templates", { defaultValue: "Templates" })}
              </SidebarContent.SectionLabel>
            </SidebarContent.SectionHeader>
            {[...userTemplates, ...BUILT_IN_TEMPLATES].map((template) => {
              const isUserTemplate = !template.id.startsWith("__builtin_");
              const templateName = getTemplateName(template, t);
              const templateInstructions = getTemplateInstructions(template, t);
              return (
                <div key={template.id} className="group relative mb-1.5">
                  <SidebarContent.Item
                    variant={isUserTemplate ? "accent-soft" : "dashed"}
                    onClick={() => {
                      setForm({
                        ...emptyForm,
                        displayName: templateName,
                        instructions: templateInstructions,
                        durationValue: template.interval,
                        durationUnit: template.unit,
                      });
                      setEditorOpen(true);
                      setEditingId(null);
                      setSelectedTriggerId(null);
                      setTemplateNotice(
                        t("heartbeatsview.TemplateLoadedNotice", {
                          defaultValue:
                            'Template "{{name}}" loaded. Customize and create.',
                          name: templateName,
                        }),
                      );
                      setTimeout(() => setTemplateNotice(null), 3000);
                    }}
                  >
                    <div className="text-xs font-medium text-txt">
                      {templateName}
                    </div>
                    <div className="mt-0.5 text-2xs text-muted/60">
                      {t("heartbeatsview.EveryIntervalUnit", {
                        defaultValue: "Every {{interval}} {{unit}}",
                        interval: template.interval,
                        unit: template.unit,
                      })}
                    </div>
                  </SidebarContent.Item>
                  {isUserTemplate && (
                    <SidebarContent.ItemAction
                      aria-label={t("heartbeatsview.DeleteTemplate", {
                        defaultValue: "Delete template",
                      })}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteUserTemplate(template.id);
                      }}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </SidebarContent.ItemAction>
                  )}
                </div>
              );
            })}
          </div>
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  );

  return (
    <ShellViewAgentSurface viewId="heartbeats">
      <PageLayout
        className="h-full bg-transparent"
        data-testid="heartbeats-shell"
        sidebar={heartbeatsSidebar}
        contentInnerClassName="mx-auto w-full max-w-[96rem]"
        mobileSidebarLabel={mobileSidebarLabel}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {showDetailPane ? (
            <Button
              variant="ghost"
              className="mb-3 flex h-auto items-center justify-start gap-2 px-0 py-2 text-base font-medium text-muted hover:bg-transparent hover:text-txt md:hidden"
              onClick={() => {
                setSelectedTriggerId(null);
                setEditorOpen(false);
                setEditingId(null);
              }}
            >
              {t("common.back", {
                defaultValue: "\u2190 Back",
              })}
            </Button>
          ) : null}

          <ChatSearchHint
            noun="heartbeats"
            query={searchQuery}
            className="mb-3"
          />

          <LongRunningHostBanner triggers={triggers} />

          {editorOpen || editingId ? (
            <HeartbeatForm
              form={form}
              editingId={editingId}
              editorEnabled={editorEnabled}
              modalTitle={modalTitle}
              formError={formError}
              triggersSaving={triggersSaving}
              templateNotice={templateNotice}
              triggers={triggers}
              triggerRunsById={triggerRunsById}
              t={t}
              selectedTriggerId={selectedTriggerId}
              setField={setField}
              setForm={setForm}
              setFormError={setFormError}
              closeEditor={closeEditor}
              onSubmit={onSubmit}
              onDelete={onDelete}
              onRunSelectedTrigger={onRunSelectedTrigger}
              onToggleTriggerEnabled={onToggleTriggerEnabled}
              saveFormAsTemplate={saveFormAsTemplate}
              loadTriggerRuns={loadTriggerRuns}
            />
          ) : selectedTrigger ? (
            <div className="w-full">
              <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <FieldLabel variant="kicker">
                      {t("common.heartbeat")}
                    </FieldLabel>
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs ${
                        selectedTrigger.enabled
                          ? "text-ok"
                          : "text-muted-strong"
                      }`}
                    >
                      <StatusDot
                        tone={selectedTrigger.enabled ? "success" : "muted"}
                      />
                      {selectedTrigger.enabled
                        ? t("common.active")
                        : t("common.paused")}
                    </span>
                  </div>
                  <h2 className="text-2xl font-semibold text-txt sm:text-[2rem]">
                    {selectedTrigger.displayName}
                  </h2>
                  <p className="text-sm leading-relaxed text-muted sm:text-sm">
                    {selectedTrigger.instructions}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                  <Button
                    ref={toggleEnabledAgent.ref}
                    variant="outline"
                    size="sm"
                    className={`h-8 px-3 text-xs ${selectedTrigger.enabled ? "border-warning/30 text-warning hover:bg-warning/10" : "border-ok/30 text-ok hover:bg-ok/10"}`}
                    onClick={() =>
                      void onToggleTriggerEnabled(
                        selectedTrigger.id,
                        selectedTrigger.enabled,
                      )
                    }
                    {...toggleEnabledAgent.agentProps}
                  >
                    {selectedTrigger.enabled
                      ? t("common.pause")
                      : t("common.resume")}
                  </Button>
                  <Button
                    ref={editHeartbeatAgent.ref}
                    variant="outline"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    onClick={() => openEditEditor(selectedTrigger)}
                    {...editHeartbeatAgent.agentProps}
                  >
                    {t("common.edit")}
                  </Button>
                  <Button
                    ref={duplicateHeartbeatAgent.ref}
                    variant="outline"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    onClick={() => {
                      setForm({
                        ...formFromTrigger(selectedTrigger),
                        displayName: `${selectedTrigger.displayName} (copy)`,
                      });
                      setEditorOpen(true);
                      setEditingId(null);
                      setSelectedTriggerId(null);
                    }}
                    {...duplicateHeartbeatAgent.agentProps}
                  >
                    {t("heartbeatsview.duplicate")}
                  </Button>
                  <Button
                    ref={runNowAgent.ref}
                    variant="outline"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    onClick={() =>
                      void onRunSelectedTrigger(selectedTrigger.id)
                    }
                    {...runNowAgent.agentProps}
                  >
                    {t("triggersview.RunNow")}
                  </Button>
                </div>
              </div>

              <dl className="mb-8 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
                <PagePanel.SummaryCard className="px-4 py-4">
                  <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
                    {t("common.schedule")}
                  </dt>
                  <dd className="mt-1 font-medium text-txt">
                    {scheduleLabel(selectedTrigger, t, uiLanguage)}
                  </dd>
                </PagePanel.SummaryCard>
                <PagePanel.SummaryCard className="px-4 py-4">
                  <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
                    {t("triggersview.LastRun")}
                  </dt>
                  <dd className="mt-1 font-medium text-txt">
                    {formatDateTime(selectedTrigger.lastRunAtIso, {
                      fallback: t("heartbeatsview.notYetRun"),
                      locale: uiLanguage,
                    })}
                  </dd>
                </PagePanel.SummaryCard>
                <PagePanel.SummaryCard className="px-4 py-4">
                  <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
                    {t("heartbeatsview.nextRun")}
                  </dt>
                  <dd className="mt-1 font-medium text-txt">
                    {formatDateTime(selectedTrigger.nextRunAtMs, {
                      fallback: t("heartbeatsview.notScheduled"),
                      locale: uiLanguage,
                    })}
                  </dd>
                </PagePanel.SummaryCard>
                {hasLoadedSelectedRuns && selectedRunCount > 0 ? (
                  <PagePanel.SummaryCard className="px-4 py-4">
                    <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
                      {t("heartbeatsview.runStats")}
                    </dt>
                    <dd className="mt-1 flex items-center gap-2 text-sm font-medium">
                      <span className="text-txt">
                        {t("heartbeatsview.runCountPlural", {
                          count: selectedRunCount,
                        })}
                      </span>
                      {successCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-ok">
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                          {successCount}
                        </span>
                      ) : null}
                      {failureCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-danger">
                          <XCircle className="h-3.5 w-3.5" aria-hidden />
                          {failureCount}
                        </span>
                      ) : null}
                    </dd>
                  </PagePanel.SummaryCard>
                ) : null}
              </dl>

              <PagePanel variant="padded" className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                    {t("triggersview.RunHistory")}
                  </div>
                  <Button
                    ref={refreshRunsAgent.ref}
                    variant="outline"
                    size="sm"
                    className="h-7 px-3 text-xs-tight"
                    onClick={() => void loadTriggerRuns(selectedTrigger.id)}
                    {...refreshRunsAgent.agentProps}
                  >
                    {t("common.refresh")}
                  </Button>
                </div>

                {!hasLoadedSelectedRuns ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-muted/70">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
                    {t("appsview.Loading")}
                  </div>
                ) : selectedRuns.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted/60">
                    {t("heartbeatsview.noRunsYetMessage")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selectedRuns.map((run) => (
                      <div key={run.triggerRunId} className="py-1">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-txt">
                            <StatusDot tone={toneForLastStatus(run.status)} />
                            {localizedExecutionStatus(run.status, t)}
                          </span>
                          <span className="font-mono text-xs-tight text-muted/70">
                            {formatDateTime(run.startedAt, {
                              locale: uiLanguage,
                            })}
                          </span>
                        </div>
                        <div className="text-xs-tight text-muted/80">
                          {formatDurationMs(run.latencyMs, { t })} &middot;{" "}
                          <span className="font-mono text-muted/60">
                            {run.source}
                          </span>
                        </div>
                        {run.error ? (
                          <div className="mt-2 whitespace-pre-wrap rounded-sm border border-danger/20 bg-danger/10 p-2 font-mono text-xs text-danger/90">
                            {run.error}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </PagePanel>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10 text-center">
              <h3 className="text-lg font-semibold text-txt-strong">
                {showFirstRunEmptyState
                  ? t("heartbeatsview.createFirstHeartbeat")
                  : t("heartbeatsview.selectAHeartbeat")}
              </h3>
            </div>
          )}
        </div>
      </PageLayout>
    </ShellViewAgentSurface>
  );
}

export function HeartbeatsDesktopShell() {
  return (
    <HeartbeatsViewProvider>
      <HeartbeatsLayout />
    </HeartbeatsViewProvider>
  );
}

export function HeartbeatsView() {
  return (
    <HeartbeatsViewProvider>
      <HeartbeatsLayout />
    </HeartbeatsViewProvider>
  );
}
