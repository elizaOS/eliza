/**
 * BlockerRegistry. Blockers (hosts-file website blocker on macOS, iOS Family
 * Controls / Android Usage Access for app blocking) are registry-driven so the
 * `WEBSITE_BLOCK` and `APP_BLOCK` umbrella actions dispatch through one
 * canonical surface instead of branching on `kind` inline.
 *
 * The registry is dispatcher-internal — `WEBSITE_BLOCK` / `APP_BLOCK` remain
 * the user-visible umbrella verbs. Adding a new blocker (e.g. a router-level
 * DNS blocker, a Bluetooth-tether blocker) is a registration call, not a new
 * action.
 *
 * Outbound contract (one entry per enforcer):
 *   - `kind`: stable enforcer key — `"website"` for the macOS hosts-file
 *     blocker, `"app"` for the iOS/Android phone-app blocker.
 *   - `start(request)` / `stop()` / `status()`: enforcement primitives the
 *     umbrella action calls. Result types are blocker-specific (websites
 *     return host lists; apps return blocked package counts) so the
 *     registry surfaces them without a forced common shape.
 *   - `verifyAvailable()`: unified availability probe used at first-run and
 *     before every dispatch. Returns reason text on failure so the action
 *     can surface it to the user verbatim.
 */

import type { IAgentRuntime } from "@elizaos/core";

export type BlockerKind = "website" | "app";

export interface BlockerAvailability {
  available: boolean;
  /** Free-form reason text. Required when `available === false`. */
  reason: string | null;
  /**
   * `granted` means the OS has handed the blocker the permission it needs;
   * `prompt` means we can ask; `denied` means we cannot ask without manual
   * user intervention; `not-applicable` means the blocker has no permission
   * model on this platform.
   */
  permission: "granted" | "prompt" | "denied" | "not-applicable";
}

export interface BlockerStatusSummary {
  /** Whether an enforcement is currently active. */
  active: boolean;
  /** ISO timestamp; `null` for indefinite blocks. */
  endsAt: string | null;
  /** Free-form summary text the umbrella action surfaces verbatim. */
  text: string;
}

/**
 * One registered enforcer. The shape is intentionally minimal — the umbrella
 * actions own the LLM extraction, draft/confirm flow, and chat replies; the
 * enforcer only owns the OS-level start/stop/status primitives.
 *
 * Generic over the `start` request type because hosts-file websites and
 * phone-app blocks have different inputs and forcing a union here would
 * push runtime branching back into callers.
 */
export interface BlockerContribution<StartRequest, StartResult> {
  kind: BlockerKind;

  /** Short human label, surfaces in pack-detail UI / debug logs. */
  describe: { label: string };

  verifyAvailable(): Promise<BlockerAvailability>;

  /** Start enforcement. The umbrella action passes through pre-validated input. */
  start(request: StartRequest): Promise<StartResult>;

  /** Stop the active enforcement. */
  stop(): Promise<void>;

  /** Compact summary for status reads. */
  status(): Promise<BlockerStatusSummary>;
}

export interface BlockerRegistry {
  register<StartRequest, StartResult>(
    contribution: BlockerContribution<StartRequest, StartResult>,
  ): void;
  list(): BlockerContribution<unknown, unknown>[];
  get(kind: BlockerKind): BlockerContribution<unknown, unknown> | null;
}

class InMemoryBlockerRegistry implements BlockerRegistry {
  private readonly byKind = new Map<
    BlockerKind,
    BlockerContribution<unknown, unknown>
  >();

  register<StartRequest, StartResult>(
    contribution: BlockerContribution<StartRequest, StartResult>,
  ): void {
    if (this.byKind.has(contribution.kind)) {
      throw new Error(
        `[BlockerRegistry] kind "${contribution.kind}" already registered`,
      );
    }
    this.byKind.set(
      contribution.kind,
      contribution as BlockerContribution<unknown, unknown>,
    );
  }

  list(): BlockerContribution<unknown, unknown>[] {
    return Array.from(this.byKind.values());
  }

  get(kind: BlockerKind): BlockerContribution<unknown, unknown> | null {
    return this.byKind.get(kind) ?? null;
  }
}

export function createBlockerRegistry(): BlockerRegistry {
  return new InMemoryBlockerRegistry();
}

/**
 * Per-runtime registration. Mirrors `registerConnectorRegistry` /
 * `registerSendPolicy` — `WeakMap` keyed by runtime so the registry lifetime
 * tracks the runtime and tests don't leak registrations across each other.
 */
const registries = new WeakMap<IAgentRuntime, BlockerRegistry>();

export function registerBlockerRegistry(
  runtime: IAgentRuntime,
  registry: BlockerRegistry,
): void {
  registries.set(runtime, registry);
}

export function getBlockerRegistry(
  runtime: IAgentRuntime,
): BlockerRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetBlockerRegistryForTests(runtime: IAgentRuntime): void {
  registries.delete(runtime);
}
