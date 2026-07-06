/**
 * Diff-scoped ratchet for the chat-first builtin-view contract.
 *
 * Builtin shell views may render buttons, toggles, filters, drag/drop handlers,
 * and form controls, but a user must be able to drive the same mutation through
 * a semantic agent action. Third-party plugin views use the generic
 * agent-surface bridge and are audited elsewhere; this file tracks only the
 * first-party pages bundled into the shell.
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
    ],
    semanticActions: ["APP", "SETTINGS", "CONNECTOR", "CREDENTIALS", "RUNTIME"],
    maxMutationSites: 14,
    notes:
      "Plugin enable/config/reorder/setup flows are covered by app/settings/connector/credential/runtime actions; the count ratchets local-only control growth.",
  },
  {
    viewId: "settings",
    sourceFiles: [
      "packages/ui/src/components/pages/SettingsView.tsx",
      "packages/ui/src/components/pages/ConfigPageView.tsx",
      "packages/ui/src/components/pages/PluginConfigForm.tsx",
    ],
    semanticActions: [
      "SETTINGS",
      "MODEL_SWITCH",
      "BACKGROUND",
      "CHARACTER",
      "CONNECTOR",
      "CREDENTIALS",
    ],
    maxMutationSites: 18,
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
    maxMutationSites: 53,
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
    ],
    semanticActions: [],
    maxMutationSites: 15,
    exemptReason:
      "developer diagnostic view; SQL/editor controls are not MVP chat mutations",
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
