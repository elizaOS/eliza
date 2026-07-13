import { FIRST_RUN_ACTION_PREFIX } from "./first-run-action-channel";

export type FirstRunProvisioningVisibility = "visible" | "silent";
export type FirstRunFlowMode = "runtime-chooser" | "cloud-only";

export type FirstRunFlowPhase =
  | { kind: "choosing-runtime" }
  | { kind: "choosing-provider" }
  | { kind: "connecting-remote" }
  | { kind: "restoring-backup" }
  | { kind: "signing-in" }
  | { kind: "handoff" }
  | {
      kind: "provisioning";
      visibility: FirstRunProvisioningVisibility;
    }
  | { kind: "choosing-cloud-agent" }
  | { kind: "wrap-up" }
  | { kind: "error"; message: string }
  | { kind: "complete" };

export type FirstRunFlowPhaseKind = FirstRunFlowPhase["kind"];

type PhaseOf<K extends FirstRunFlowPhaseKind> = Extract<
  FirstRunFlowPhase,
  { kind: K }
>;

export const firstRunFlowPhase = {
  choosingRuntime: (): PhaseOf<"choosing-runtime"> => ({
    kind: "choosing-runtime",
  }),
  choosingProvider: (): PhaseOf<"choosing-provider"> => ({
    kind: "choosing-provider",
  }),
  connectingRemote: (): PhaseOf<"connecting-remote"> => ({
    kind: "connecting-remote",
  }),
  restoringBackup: (): PhaseOf<"restoring-backup"> => ({
    kind: "restoring-backup",
  }),
  signingIn: (): PhaseOf<"signing-in"> => ({ kind: "signing-in" }),
  handoff: (): PhaseOf<"handoff"> => ({ kind: "handoff" }),
  provisioning: (
    visibility: FirstRunProvisioningVisibility = "visible",
  ): PhaseOf<"provisioning"> => ({ kind: "provisioning", visibility }),
  choosingCloudAgent: (): PhaseOf<"choosing-cloud-agent"> => ({
    kind: "choosing-cloud-agent",
  }),
  wrapUp: (): PhaseOf<"wrap-up"> => ({ kind: "wrap-up" }),
  error: (message: string): PhaseOf<"error"> => ({ kind: "error", message }),
  complete: (): PhaseOf<"complete"> => ({ kind: "complete" }),
} as const;

const BUSY_PHASES: ReadonlySet<FirstRunFlowPhaseKind> = new Set([
  "restoring-backup",
  "handoff",
  "provisioning",
]);

const PROVISIONED_PHASES: ReadonlySet<FirstRunFlowPhaseKind> = new Set([
  "wrap-up",
  "complete",
]);

export function isFirstRunFlowBusy(phase: FirstRunFlowPhase): boolean {
  return BUSY_PHASES.has(phase.kind);
}

export function isFirstRunFlowProvisioned(phase: FirstRunFlowPhase): boolean {
  return PROVISIONED_PHASES.has(phase.kind);
}

export function isFirstRunFlowSilent(
  phase: FirstRunFlowPhase,
): phase is PhaseOf<"provisioning"> & { visibility: "silent" } {
  return phase.kind === "provisioning" && phase.visibility === "silent";
}

export function revealFirstRunFlow(
  phase: FirstRunFlowPhase,
): FirstRunFlowPhase {
  return isFirstRunFlowSilent(phase)
    ? firstRunFlowPhase.provisioning("visible")
    : phase;
}

export type FirstRunActionGroup =
  | "runtime"
  | "provider"
  | "backup-restore"
  | "cloud-agent"
  | "back"
  | "error"
  | "accent"
  | "tutorial";

export interface ParsedFirstRunAction {
  group: FirstRunActionGroup;
  id: string;
  /** Canonical action value without the optional CHOICE label. */
  value: string;
}

export type FirstRunActionRoute =
  | { kind: "pass-through" }
  | {
      kind: "consume";
      reason: "malformed" | "phase" | "cloud-only";
      action?: ParsedFirstRunAction;
    }
  | { kind: "dispatch"; action: ParsedFirstRunAction };

const FIRST_RUN_ACTION_GROUPS: ReadonlySet<string> = new Set([
  "runtime",
  "provider",
  "backup-restore",
  "cloud-agent",
  "back",
  "error",
  "accent",
  "tutorial",
]);

export const FIRST_RUN_ALLOWED_ACTION_GROUPS: Readonly<
  Record<FirstRunFlowPhaseKind, readonly FirstRunActionGroup[]>
> = {
  "choosing-runtime": ["runtime", "backup-restore"],
  "choosing-provider": ["provider", "back"],
  "connecting-remote": ["back"],
  "restoring-backup": ["runtime"],
  "signing-in": ["runtime"],
  handoff: [],
  provisioning: [],
  "choosing-cloud-agent": ["cloud-agent", "back"],
  "wrap-up": ["accent", "tutorial"],
  error: ["error"],
  complete: [],
};

function isFirstRunActionGroup(value: string): value is FirstRunActionGroup {
  return FIRST_RUN_ACTION_GROUPS.has(value);
}

/** Parse a reserved CHOICE value. Non-first-run and malformed values return null. */
export function parseFirstRunAction(
  value: string,
): ParsedFirstRunAction | null {
  if (!value.startsWith(FIRST_RUN_ACTION_PREFIX)) return null;

  const actionValue = value
    .slice(FIRST_RUN_ACTION_PREFIX.length)
    .split("=", 1)[0]
    ?.trim();
  if (!actionValue) return null;

  const separator = actionValue.indexOf(":");
  if (separator <= 0 || separator === actionValue.length - 1) return null;

  const group = actionValue.slice(0, separator).trim();
  const id = actionValue.slice(separator + 1).trim();
  if (!isFirstRunActionGroup(group) || !id) return null;

  return {
    group,
    id,
    value: `${FIRST_RUN_ACTION_PREFIX}${group}:${id}`,
  };
}

/**
 * Route a chat value without leaking reserved onboarding sentinels to the agent.
 * Reserved values are dispatched only when their group belongs to the phase.
 */
export function routeFirstRunAction(
  phase: FirstRunFlowPhase,
  value: string,
  options: { mode?: FirstRunFlowMode } = {},
): FirstRunActionRoute {
  if (!value.startsWith(FIRST_RUN_ACTION_PREFIX)) {
    return { kind: "pass-through" };
  }

  const action = parseFirstRunAction(value);
  if (!action) return { kind: "consume", reason: "malformed" };

  const allowedGroups = FIRST_RUN_ALLOWED_ACTION_GROUPS[phase.kind];
  if (!allowedGroups.includes(action.group)) {
    return { kind: "consume", reason: "phase", action };
  }

  if (options.mode === "cloud-only") {
    const chooserOnlyGroup =
      action.group === "provider" ||
      action.group === "backup-restore" ||
      action.group === "back";
    const unsupportedRuntime =
      action.group === "runtime" && action.id !== "cloud";
    const unavailableErrorRestart =
      action.group === "error" && action.id === "restart";
    if (chooserOnlyGroup || unsupportedRuntime || unavailableErrorRestart) {
      return { kind: "consume", reason: "cloud-only", action };
    }
  }

  return { kind: "dispatch", action };
}
