/**
 * Diff-scoped ratchet for the chat-first builtin-view contract.
 *
 * Builtin shell views may render buttons, toggles, filters, drag/drop handlers,
 * and form controls, but a user must be able to drive the same mutation through
 * a semantic agent action. Third-party plugin views use the generic
 * agent-surface bridge and are audited elsewhere; this file tracks only the
 * first-party pages bundled into the shell.
 *
 * Two checks compose the ratchet (#14369 shipped the first, #16944 the second):
 * the per-view coverage validator pins each baseline entry's mutation-site
 * count and verifies its semantic actions against the live registered-action
 * inventory, and the shell-page completeness sweep walks every module under
 * `packages/ui/src/components/pages` and fails when a mutating page is neither
 * claimed by a baseline entry nor exempt with a reason — so a brand-new
 * mutating view cannot ship un-ratcheted.
 */

export interface BuiltinViewMutationBaselineEntry {
  viewId: string;
  sourceFiles: readonly string[];
  semanticActions: readonly string[];
  maxMutationSites: number;
  exemptReason?: string;
  notes?: string;
}

export interface BuiltinViewMutationFinding {
  viewId: string;
  code: "missing-source" | "missing-semantic-action" | "new-local-mutation";
  message: string;
}

export interface BuiltinViewMutationCoverage {
  viewId: string;
  observedMutationSites: number;
  maxMutationSites: number;
  semanticActions: readonly string[];
  exempt: boolean;
}

export interface BuiltinViewMutationValidationResult {
  ok: boolean;
  coverage: BuiltinViewMutationCoverage[];
  findings: BuiltinViewMutationFinding[];
}

export const BUILTIN_VIEW_MUTATION_BASELINE = [
  {
    viewId: "tasks",
    sourceFiles: ["packages/ui/src/components/pages/TasksPageView.tsx"],
    semanticActions: ["SCHEDULED_TASKS"],
    maxMutationSites: 0,
    notes:
      "Task list filters and row selection are covered by the scheduled-task semantic action.",
  },
  {
    viewId: "plugins-page",
    sourceFiles: [
      "packages/ui/src/components/pages/PluginsPageView.tsx",
      "packages/ui/src/components/pages/PluginsView.tsx",
      "packages/ui/src/components/pages/PluginCard.tsx",
      "packages/ui/src/components/pages/PluginConfigForm.tsx",
      "packages/ui/src/components/pages/plugin-view-connectors.tsx",
      "packages/ui/src/components/pages/plugin-view-modal.tsx",
      "packages/ui/src/components/pages/plugin-view-dialogs.tsx",
    ],
    semanticActions: [
      "APP",
      "SETTINGS",
      "PLUGIN",
      "SECRETS",
      "RUNTIME",
      "CONNECTOR",
    ],
    maxMutationSites: 62,
    notes:
      "Plugin enable/config/reorder/setup flows are covered by app/settings/plugin/secrets/runtime actions; connector setup dialogs (plugin-view-connectors) pair with CONNECTOR. The count ratchets local-only control growth.",
  },
  {
    viewId: "settings",
    sourceFiles: [
      "packages/ui/src/components/pages/SettingsView.tsx",
      "packages/ui/src/components/pages/ConfigPageView.tsx",
      "packages/ui/src/components/pages/PluginConfigForm.tsx",
      "packages/ui/src/components/pages/config-page-sections.tsx",
      "packages/ui/src/components/pages/SecretsView.tsx",
    ],
    semanticActions: [
      "SETTINGS",
      "MODEL_SWITCH",
      "BACKGROUND",
      "CHARACTER",
      "PLUGIN",
      "SECRETS",
    ],
    maxMutationSites: 32,
    notes:
      "Settings sections delegate to SETTINGS or to the dedicated action that owns the section.",
  },
  {
    viewId: "background",
    sourceFiles: ["packages/ui/src/components/pages/BackgroundView.tsx"],
    semanticActions: ["BACKGROUND"],
    maxMutationSites: 0,
  },
  {
    viewId: "character",
    sourceFiles: [
      "packages/ui/src/components/character/CharacterEditor.tsx",
      "packages/ui/src/components/character/CharacterEditorPanels.tsx",
    ],
    semanticActions: [
      "CHARACTER",
      "VIEW_CHARACTER_FILL_BIO",
      "VIEW_CHARACTER_ADD_STYLE_RULE",
      "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
    ],
    maxMutationSites: 57,
    notes:
      "Identity panel added the agent name + system-prompt fields; each carries a useAgentElement/onFill agent-surface binding (agent-drivable) covered by the CHARACTER action (+53 → +57).",
  },
  {
    viewId: "logs",
    sourceFiles: ["packages/ui/src/components/pages/LogsView.tsx"],
    semanticActions: [],
    maxMutationSites: 10,
    exemptReason:
      "read-only diagnostic view; controls are local inspect/filter affordances",
  },
  {
    viewId: "runtime",
    sourceFiles: ["packages/ui/src/components/pages/RuntimeView.tsx"],
    semanticActions: [],
    maxMutationSites: 12,
    exemptReason: "read-only diagnostic view",
  },
  {
    viewId: "database",
    sourceFiles: [
      "packages/ui/src/components/pages/DatabasePageView.tsx",
      "packages/ui/src/components/pages/DatabaseView.tsx",
      "packages/ui/src/components/pages/SqlEditorPanel.tsx",
      "packages/ui/src/components/pages/database-utils.tsx",
      "packages/ui/src/components/pages/MediaGalleryView.tsx",
    ],
    semanticActions: [],
    maxMutationSites: 26,
    exemptReason:
      "developer diagnostic view; SQL/editor/media-table browsing controls are not MVP chat mutations",
  },
  {
    viewId: "trajectories",
    sourceFiles: [
      "packages/ui/src/components/pages/TrajectoriesView.tsx",
      "packages/ui/src/components/pages/TrajectoryDetailView.tsx",
    ],
    semanticActions: [],
    maxMutationSites: 12,
    exemptReason: "read-only trajectory inspection view",
  },
  {
    viewId: "documents",
    sourceFiles: [
      "packages/ui/src/components/pages/DocumentsView.tsx",
      "packages/ui/src/components/pages/documents-detail.tsx",
      "packages/ui/src/components/pages/KnowledgeView.tsx",
    ],
    semanticActions: ["OWNER_DOCUMENTS", "DOCUMENT"],
    maxMutationSites: 17,
    notes:
      "Knowledge-hub upload/delete/tag controls have DOCUMENT (core CRUD) and OWNER_DOCUMENTS (personal-assistant portal) as chat twins, per the builtin-views relatedActions mapping.",
  },
  {
    viewId: "files",
    sourceFiles: ["packages/ui/src/components/pages/FilesView.tsx"],
    semanticActions: ["FILES"],
    maxMutationSites: 10,
    notes:
      "File browser upload/delete/rename controls pair with the FILES action (packages/agent/src/actions/files.ts).",
  },
  {
    viewId: "memories",
    sourceFiles: [
      "packages/ui/src/components/pages/MemoryViewerView.tsx",
      "packages/ui/src/components/pages/MemoryDetailPanel.tsx",
    ],
    semanticActions: ["MEMORY"],
    maxMutationSites: 21,
    notes:
      "Memory browse/prune controls pair with MEMORY (op create|search|update|delete, packages/agent/src/actions/memories.ts).",
  },
  {
    viewId: "automations",
    sourceFiles: [
      "packages/ui/src/components/pages/AutomationsFeed.tsx",
      "packages/ui/src/components/pages/TaskEditor.tsx",
      "packages/ui/src/components/pages/ScheduledTaskEditor.tsx",
      "packages/ui/src/components/pages/WorkflowEditor.tsx",
      "packages/ui/src/components/pages/WorkflowGraphViewer.tsx",
    ],
    semanticActions: ["SCHEDULED_TASKS", "TRIGGER"],
    maxMutationSites: 71,
    notes:
      "Automations feed plus its task/workflow editors all write ScheduledTask records through the one scheduler; SCHEDULED_TASKS is the umbrella twin and TRIGGER pairs the trigger steps inside workflow editing.",
  },
  {
    viewId: "triggers",
    sourceFiles: [
      "packages/ui/src/components/pages/TriggersView.tsx",
      "packages/ui/src/components/pages/TriggerForm.tsx",
    ],
    semanticActions: ["TRIGGER"],
    maxMutationSites: 66,
    notes:
      "Trigger editor (mounted as a detached desktop shell window via app-core DetachedShellRoot) pairs with the TRIGGER action (packages/agent/src/actions/trigger.ts).",
  },
  {
    viewId: "skills",
    sourceFiles: [
      "packages/ui/src/components/pages/SkillsView.tsx",
      "packages/ui/src/components/pages/skill-marketplace.tsx",
      "packages/ui/src/components/pages/skill-detail-panel.tsx",
    ],
    semanticActions: ["SKILL", "USE_SKILL"],
    maxMutationSites: 56,
    notes:
      "Skill install/toggle/uninstall and marketplace flows pair with SKILL (manage) and USE_SKILL (invoke) from plugin-agent-skills.",
  },
  {
    viewId: "browser",
    sourceFiles: [
      "packages/ui/src/components/pages/BrowserWorkspaceView.tsx",
      "packages/ui/src/components/pages/BrowserTabSwitcher.tsx",
    ],
    semanticActions: ["BROWSER"],
    maxMutationSites: 23,
    notes:
      "Browser workspace navigation/tab controls pair with the BROWSER action (plugin-browser); wallet-consent prompts are owner-in-the-loop by design and stay counted here.",
  },
  {
    viewId: "relationships",
    sourceFiles: [
      "packages/ui/src/components/pages/RelationshipsView.tsx",
      "packages/ui/src/components/pages/RelationshipsGraphPanel.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsWorkspaceView.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsPersonPanels.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsCandidateMergesPanel.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsActivityFeed.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsSidebar.tsx",
    ],
    semanticActions: ["ENTITY", "CONTACT"],
    maxMutationSites: 29,
    notes:
      "Relationship workspace person edits and merge approvals go through EntityStore/RelationshipStore; ENTITY (personal-assistant) and CONTACT (agent contact CRUD) are the chat twins.",
  },
  {
    viewId: "chat",
    sourceFiles: ["packages/ui/src/components/pages/ChatView.tsx"],
    semanticActions: [],
    maxMutationSites: 4,
    exemptReason:
      "the chat surface IS the semantic channel; its composer/attachment controls are how users reach every action, not mutations needing a chat twin",
  },
  {
    viewId: "launcher",
    sourceFiles: ["packages/ui/src/components/pages/Launcher.tsx"],
    semanticActions: [],
    maxMutationSites: 3,
    exemptReason:
      "read-only launcher grid; tile taps navigate to views (VIEWS action drives the same navigation) and mutate no domain state",
  },
  {
    viewId: "native-os-apps",
    sourceFiles: ["packages/ui/src/components/pages/ElizaOsAppsView.tsx"],
    semanticActions: [],
    maxMutationSites: 48,
    exemptReason:
      "AOSP-fork native OS surfaces (dialer, SMS, contacts) driven through the native-plugins bridge; device telephony affordances, not agent-domain mutations",
  },
  {
    viewId: "camera",
    sourceFiles: ["packages/ui/src/components/pages/CameraPageView.tsx"],
    semanticActions: [],
    maxMutationSites: 4,
    exemptReason:
      "native camera preview surface (AOSP home tile); capture/switch controls are device affordances, not agent-domain mutations",
  },
  {
    viewId: "cloud-dashboard",
    sourceFiles: ["packages/ui/src/components/pages/ElizaCloudDashboard.tsx"],
    semanticActions: [],
    maxMutationSites: 15,
    exemptReason:
      "cloud billing surface; Stripe checkout, top-up, and spend-limit changes are deliberately owner-in-the-loop consent flows, never agent-drivable (reads pair with CLOUD_ACCOUNT_STATUS)",
  },
  {
    viewId: "pendant-transcript",
    sourceFiles: ["packages/ui/src/components/pages/PendantTranscriptView.tsx"],
    semanticActions: [],
    maxMutationSites: 7,
    exemptReason:
      "device-local BLE pendant capture surface; segments live in a browser-local optimistic cache, not agent domain state",
  },
  {
    viewId: "release-center",
    sourceFiles: ["packages/ui/src/components/pages/ReleaseCenterView.tsx"],
    semanticActions: [],
    maxMutationSites: 13,
    exemptReason:
      "operator update surface (runtime/desktop update check + apply); the update lifecycle is owner-driven infrastructure with no chat-mutation twin",
  },
] as const satisfies readonly BuiltinViewMutationBaselineEntry[];

const MUTATION_SITE_RE =
  /\b(?:onClick|onSubmit|onChange|onCheckedChange|onValueChange|onDragEnd|onDrop|onKeyDown|onPointerDown|onPointerUp)\s*=|\buseAgentElement(?:<[^>]*>)?\(/g;

export function countBuiltinViewMutationSites(source: string): number {
  return source.match(MUTATION_SITE_RE)?.length ?? 0;
}

export function validateBuiltinViewMutationCoverage(args: {
  baseline?: readonly BuiltinViewMutationBaselineEntry[];
  readSource: (path: string) => string | null | undefined;
  registeredActions: ReadonlySet<string>;
}): BuiltinViewMutationValidationResult {
  const baseline: readonly BuiltinViewMutationBaselineEntry[] =
    args.baseline ?? BUILTIN_VIEW_MUTATION_BASELINE;
  const registeredActions = new Set(
    [...args.registeredActions].map((action) => action.toUpperCase()),
  );
  const findings: BuiltinViewMutationFinding[] = [];
  const coverage: BuiltinViewMutationCoverage[] = [];

  for (const entry of baseline) {
    let observedMutationSites = 0;
    for (const sourceFile of entry.sourceFiles) {
      const source = args.readSource(sourceFile);
      if (source == null) {
        findings.push({
          viewId: entry.viewId,
          code: "missing-source",
          message: `${entry.viewId}: missing source ${sourceFile}`,
        });
        continue;
      }
      observedMutationSites += countBuiltinViewMutationSites(source);
    }

    const exempt = Boolean(entry.exemptReason);
    coverage.push({
      viewId: entry.viewId,
      observedMutationSites,
      maxMutationSites: entry.maxMutationSites,
      semanticActions: entry.semanticActions,
      exempt,
    });

    if (observedMutationSites > entry.maxMutationSites) {
      findings.push({
        viewId: entry.viewId,
        code: "new-local-mutation",
        message: `${entry.viewId}: observed ${observedMutationSites} mutation sites exceeds baseline ${entry.maxMutationSites}; add a semantic action mapping or deliberately update the baseline`,
      });
    }

    if (exempt) continue;
    for (const action of entry.semanticActions) {
      if (registeredActions.has(action.toUpperCase())) continue;
      findings.push({
        viewId: entry.viewId,
        code: "missing-semantic-action",
        message: `${entry.viewId}: semantic action ${action} is not registered in the action catalog used by the ratchet`,
      });
    }
    if (entry.semanticActions.length === 0) {
      findings.push({
        viewId: entry.viewId,
        code: "missing-semantic-action",
        message: `${entry.viewId}: mutating builtin view is not exempt and declares no semantic action mapping`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    coverage,
    findings,
  };
}

export interface ShellPageSweepExemption {
  sourceFile: string;
  reason: string;
}

/**
 * Page modules excluded from the completeness sweep. Reserved for files that
 * are not mounted view surfaces at all — anything a user can actually reach
 * belongs in BUILTIN_VIEW_MUTATION_BASELINE (mapped or exempt-with-reason)
 * where its mutation-site count is also ratcheted.
 */
export const SHELL_PAGE_SWEEP_EXEMPTIONS = [
  {
    sourceFile: "packages/ui/src/components/pages/documents-upload.tsx",
    reason:
      "UploadZone is not imported by any mounted surface (DocumentsView uses documents-upload.helpers directly); exercised only by its own dnd test — dead-module candidate, tracked in #16944",
  },
  {
    sourceFile: "packages/ui/src/components/pages/plugin-view-sidebar.tsx",
    reason:
      "ConnectorSidebar is not imported by any mounted surface (PluginsView renders plugin-view-connectors instead) — dead-module candidate, tracked in #16944",
  },
] as const satisfies readonly ShellPageSweepExemption[];

export interface ShellPageSweepFinding {
  sourceFile: string;
  code:
    | "unmapped-mutating-page"
    | "missing-source"
    | "stale-exemption"
    | "conflicting-exemption";
  message: string;
}

export interface ShellPageSweepInventoryRow {
  sourceFile: string;
  mutationSites: number;
  /** viewId of the baseline entry that claims the file, or null. */
  coveredBy: string | null;
  exempt: boolean;
}

export interface ShellPageSweepResult {
  ok: boolean;
  findings: ShellPageSweepFinding[];
  inventory: ShellPageSweepInventoryRow[];
}

/**
 * Baseline-completeness sweep (#16944): every enumerated shell page module
 * with at least one mutation site must be claimed by a baseline entry's
 * sourceFiles or carry an explicit exemption. The caller enumerates
 * `pageFiles` (the test walks packages/ui/src/components/pages) so this stays
 * pure and testable against synthetic inventories. Exemptions are themselves
 * ratcheted: one that points at a deleted file, a file the baseline already
 * claims, or a file with no mutation sites left fails as stale/conflicting so
 * the list cannot rot into silent grandfathering.
 */
export function validateShellPageSweepCompleteness(args: {
  pageFiles: readonly string[];
  baseline?: readonly BuiltinViewMutationBaselineEntry[];
  exemptions?: readonly ShellPageSweepExemption[];
  readSource: (path: string) => string | null | undefined;
}): ShellPageSweepResult {
  const baseline: readonly BuiltinViewMutationBaselineEntry[] =
    args.baseline ?? BUILTIN_VIEW_MUTATION_BASELINE;
  const exemptions: readonly ShellPageSweepExemption[] =
    args.exemptions ?? SHELL_PAGE_SWEEP_EXEMPTIONS;

  const coveredBy = new Map<string, string>();
  for (const entry of baseline) {
    for (const sourceFile of entry.sourceFiles) {
      coveredBy.set(sourceFile, entry.viewId);
    }
  }
  const exemptionByFile = new Map(
    exemptions.map((exemption) => [exemption.sourceFile, exemption]),
  );

  const findings: ShellPageSweepFinding[] = [];
  const inventory: ShellPageSweepInventoryRow[] = [];
  const pageFileSet = new Set(args.pageFiles);

  for (const sourceFile of args.pageFiles) {
    const source = args.readSource(sourceFile);
    if (source == null) {
      findings.push({
        sourceFile,
        code: "missing-source",
        message: `${sourceFile}: enumerated shell page could not be read`,
      });
      continue;
    }
    const mutationSites = countBuiltinViewMutationSites(source);
    const claimedBy = coveredBy.get(sourceFile) ?? null;
    const exempt = exemptionByFile.has(sourceFile);
    inventory.push({ sourceFile, mutationSites, coveredBy: claimedBy, exempt });

    if (exempt && claimedBy != null) {
      findings.push({
        sourceFile,
        code: "conflicting-exemption",
        message: `${sourceFile}: listed both in the '${claimedBy}' baseline entry and in SHELL_PAGE_SWEEP_EXEMPTIONS; keep exactly one source of truth`,
      });
      continue;
    }
    if (mutationSites > 0 && claimedBy == null && !exempt) {
      findings.push({
        sourceFile,
        code: "unmapped-mutating-page",
        message: `${sourceFile}: ${mutationSites} mutation site(s) but no baseline coverage — add it to a BUILTIN_VIEW_MUTATION_BASELINE entry with semantic actions (or an exemptReason), or add a SHELL_PAGE_SWEEP_EXEMPTIONS entry explaining why it is not a mounted view surface`,
      });
    }
  }

  for (const exemption of exemptions) {
    if (!pageFileSet.has(exemption.sourceFile)) {
      findings.push({
        sourceFile: exemption.sourceFile,
        code: "stale-exemption",
        message: `${exemption.sourceFile}: SHELL_PAGE_SWEEP_EXEMPTIONS entry points at a file the sweep did not enumerate; remove the stale exemption`,
      });
      continue;
    }
    const source = args.readSource(exemption.sourceFile);
    if (source != null && countBuiltinViewMutationSites(source) === 0) {
      findings.push({
        sourceFile: exemption.sourceFile,
        code: "stale-exemption",
        message: `${exemption.sourceFile}: exempt file no longer contains mutation sites; remove the exemption`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    inventory,
  };
}
