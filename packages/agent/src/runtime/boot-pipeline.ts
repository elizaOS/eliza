/**
 * Typed process-boundary inputs and ordered phases for constructing an Eliza
 * agent. Runtime startup and hot replacement share these values so policy is
 * parsed once, phase order is observable, and inner boot code does not need to
 * reinterpret mutable `process.env` state.
 */

export const BOOT_PHASES = [
  "load-config",
  "resolve-settings",
  "resolve-plugin-plan",
  "construct-runtime",
  "initialize-runtime",
  "attach-host",
  "start-deferred-capabilities",
  "register-process-lifecycle",
] as const;

export type BootPhaseName = (typeof BOOT_PHASES)[number];

export interface AgentEnvironment {
  readonly values: Readonly<Record<string, string | undefined>>;
  get(key: string): string | undefined;
  isEnabled(key: string): boolean;
}

export interface BootPolicy {
  readonly allowDestructiveMigrations: boolean;
  readonly apiExposePort: boolean;
  readonly blockDeferredPluginImports: boolean;
  readonly preferredProviderPriorityBoost: number;
  readonly providerProbeTimeoutMs: number;
  readonly memorySampleIntervalMs: number;
  readonly sandboxHeartbeatIntervalMs: number;
}

export interface BootContext {
  readonly environment: AgentEnvironment;
  readonly policy: BootPolicy;
  readonly completedPhases: readonly BootPhaseName[];
  enterPhase(phase: BootPhaseName): void;
}

export type BootPhaseObserver = (phase: BootPhaseName) => void;

export type ElizaBootResult<Runtime, CloudProxy = unknown> =
  | { readonly mode: "local"; readonly runtime: Runtime }
  | { readonly mode: "cloud"; readonly proxy: CloudProxy };

export type BootHostMode =
  | "interactive"
  | "headless"
  | "server-only"
  | "local-agent";

export interface BootPlan {
  readonly hostMode: BootHostMode;
  readonly firstRun: boolean;
  readonly runtimeMode: "local" | "cloud";
  readonly bindApiListener: boolean;
}

export function resolveBootPlan(input: {
  headless?: boolean;
  serverOnly?: boolean;
  localAgentMode?: boolean;
  configured: boolean;
  cloudThinClient: boolean;
  apiExposePort: boolean;
}): BootPlan {
  const hostMode: BootHostMode = input.localAgentMode
    ? "local-agent"
    : input.serverOnly
      ? "server-only"
      : input.headless
        ? "headless"
        : "interactive";
  return Object.freeze({
    hostMode,
    firstRun: !input.configured,
    runtimeMode: input.cloudThinClient ? "cloud" : "local",
    bindApiListener: hostMode !== "local-agent" || input.apiExposePort === true,
  });
}

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);

function parseEnabled(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

export function captureAgentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): AgentEnvironment {
  const values = Object.freeze({ ...source });
  return Object.freeze({
    values,
    get(key: string): string | undefined {
      const value = values[key]?.trim();
      return value ? value : undefined;
    },
    isEnabled(key: string): boolean {
      return parseEnabled(values[key]);
    },
  });
}

export function resolveBootPolicy(environment: AgentEnvironment): BootPolicy {
  return Object.freeze({
    allowDestructiveMigrations: environment.isEnabled(
      "ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS",
    ),
    apiExposePort: environment.isEnabled("ELIZA_API_EXPOSE_PORT"),
    blockDeferredPluginImports: environment.isEnabled(
      "ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS",
    ),
    preferredProviderPriorityBoost: 10,
    providerProbeTimeoutMs: 3_000,
    memorySampleIntervalMs: 30_000,
    sandboxHeartbeatIntervalMs: 30_000,
  });
}

export function createBootContext(
  options: {
    environment?: AgentEnvironment;
    observePhase?: BootPhaseObserver;
  } = {},
): BootContext {
  const environment = options.environment ?? captureAgentEnvironment();
  const policy = resolveBootPolicy(environment);
  const completedPhases: BootPhaseName[] = [];
  let lastPhaseIndex = -1;

  return {
    environment,
    policy,
    get completedPhases(): readonly BootPhaseName[] {
      return completedPhases;
    },
    enterPhase(phase: BootPhaseName): void {
      const phaseIndex = BOOT_PHASES.indexOf(phase);
      if (phaseIndex <= lastPhaseIndex) {
        throw new Error(
          `Boot phase ${phase} cannot follow ${BOOT_PHASES[lastPhaseIndex] ?? "startup"}`,
        );
      }
      lastPhaseIndex = phaseIndex;
      completedPhases.push(phase);
      options.observePhase?.(phase);
    },
  };
}

export interface BootPhase<Context extends BootContext = BootContext> {
  readonly name: BootPhaseName;
  run(context: Context): void | Promise<void>;
  dispose?(context: Context): void | Promise<void>;
}

export async function runBootPhases<Context extends BootContext>(
  context: Context,
  phases: readonly BootPhase<Context>[],
): Promise<() => Promise<void>> {
  const completed: BootPhase<Context>[] = [];
  try {
    for (const phase of phases) {
      context.enterPhase(phase.name);
      await phase.run(context);
      completed.push(phase);
    }
  } catch (error) {
    const disposeErrors: unknown[] = [];
    for (const phase of completed.reverse()) {
      if (!phase.dispose) continue;
      try {
        await phase.dispose(context);
      } catch (disposeError) {
        disposeErrors.push(disposeError);
      }
    }
    if (disposeErrors.length > 0) {
      throw new AggregateError(
        [error, ...disposeErrors],
        "Boot failed and one or more completed phases could not be disposed",
      );
    }
    throw error;
  }

  return async () => {
    const disposeErrors: unknown[] = [];
    for (const phase of completed.reverse()) {
      if (!phase.dispose) continue;
      try {
        await phase.dispose(context);
      } catch (error) {
        disposeErrors.push(error);
      }
    }
    if (disposeErrors.length > 0) {
      throw new AggregateError(disposeErrors, "Boot phase disposal failed");
    }
  };
}
