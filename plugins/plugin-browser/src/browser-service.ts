/**
 * BrowserService — single browser dispatcher with a pluggable target
 * registry.
 *
 * The agent uses what is available: targets register themselves at plugin
 * init (or later), and the BROWSER action calls into BrowserService which
 * picks the active target. Targets can be queried by id, listed, or
 * resolved by availability.
 *
 * Built-in targets:
 *   - `workspace` — Eliza's electrobun-embedded BrowserView (with a JSDOM
 *     web-mode fallback when the desktop bridge isn't configured). Always
 *     registered by this plugin's `start`. Always available.
 *
 * Optional targets registered by other plugins:
 *   - `bridge` — registered by this plugin when a `BrowserBridgeRouteService`
 *     is reachable via the runtime; routes commands to the user's real
 *     Chrome / Safari via the Agent Browser Bridge companion extension.
 *     Available iff at least one companion is paired.
 *   - `computeruse` — registered by `@elizaos/plugin-computeruse` on plugin
 *     init when its capabilities indicate the puppeteer-driven Chromium is
 *     ready.
 *   - `stagehand` — registered by this plugin when a Stagehand command
 *     endpoint is configured; used as a low-priority fallback.
 *
 * Anyone can add a new target later by calling `registerTarget` — that's
 * the whole point of the pattern. The BROWSER action stays one action.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "./service.js";
import { maybeCreateStagehandTarget } from "./targets/stagehand-target.js";
import { getBrowserWorkspaceSnapshot } from "./workspace/browser-workspace.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceSnapshot,
} from "./workspace/browser-workspace-types.js";

export const BROWSER_SERVICE_TYPE = "browser";

export type BrowserTargetKind = "app" | "companion" | "stagehand" | "external";

export interface BrowserTargetResolutionContext {
  command: BrowserWorkspaceCommand;
  env: NodeJS.ProcessEnv;
  mobile: boolean;
}

/**
 * Pluggable browser backend. Implementations translate the canonical
 * BrowserWorkspaceCommand surface into whatever native shape they speak
 * (electrobun bridge, Chrome companion HTTP, puppeteer CDP, etc.) and
 * return the canonical BrowserWorkspaceCommandResult.
 *
 * Targets MAY decline subactions they don't support — throw a clear
 * `Error` from `execute` and the caller will see the message. Don't
 * silently ignore it.
 */
export interface BrowserTarget {
  /** Stable identifier — `workspace`, `bridge`, `computeruse`, etc. */
  readonly id: string;
  /** Short human-readable name for diagnostics. */
  readonly name: string;
  /** One-line description of what this target controls. */
  readonly description: string;
  /** Broad target class used for automatic routing. */
  readonly kind?: BrowserTargetKind;
  /** Lower scores are fallback choices. */
  readonly priority?: number;
  /**
   * Optional command-aware score. Return `null` to opt out of automatic
   * routing for this command while still allowing explicit `target`.
   */
  score?(context: BrowserTargetResolutionContext): number | null;
  /**
   * Cheap availability check. Called when the BROWSER action wants to
   * route a command and the caller didn't pin a target. Should be fast
   * (no network round-trips) when possible.
   */
  available(): Promise<boolean>;
  /** Run the command. Throw on unsupported subactions. */
  execute(
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult>;
}

export class BrowserService extends Service {
  static override readonly serviceType = BROWSER_SERVICE_TYPE;
  override capabilityDescription =
    "Single browser dispatcher with a pluggable target registry. Targets (workspace / bridge / computeruse / …) register themselves; the BROWSER action picks the active target or honors a pinned override.";

  private readonly targets = new Map<string, BrowserTarget>();
  /** Registration order — used as the default preference order. */
  private readonly targetOrder: string[] = [];

  async stop(): Promise<void> {
    this.targets.clear();
    this.targetOrder.length = 0;
  }

  static override async start(runtime: IAgentRuntime): Promise<BrowserService> {
    const service = new BrowserService(runtime);
    service.registerTarget(createWorkspaceTarget());
    // Bridge target self-registers when its dependencies (BrowserBridgeRouteService
    // implementor) are reachable via the runtime. Missing dependencies keep the
    // agent in workspace-only mode.
    try {
      const bridgeTarget = await maybeCreateBridgeTarget(runtime);
      if (bridgeTarget) service.registerTarget(bridgeTarget);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(
        `[BrowserService] bridge target not registered at start: ${message}`,
      );
    }
    try {
      const stagehandTarget = await maybeCreateStagehandTarget();
      if (stagehandTarget) service.registerTarget(stagehandTarget);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(
        `[BrowserService] stagehand target not registered at start: ${message}`,
      );
    }
    return service;
  }

  /**
   * Register a target. Idempotent on `id` — calling twice with the same id
   * replaces the previous registration without affecting registration
   * order. New ids are appended to the order list.
   */
  registerTarget(target: BrowserTarget): void {
    if (!this.targets.has(target.id)) {
      this.targetOrder.push(target.id);
    }
    this.targets.set(target.id, target);
    logger.debug(
      `[BrowserService] registered target "${target.id}" (${target.name})`,
    );
  }

  unregisterTarget(id: string): boolean {
    const removed = this.targets.delete(id);
    if (removed) {
      const idx = this.targetOrder.indexOf(id);
      if (idx >= 0) this.targetOrder.splice(idx, 1);
    }
    return removed;
  }

  listTargets(): BrowserTarget[] {
    return this.targetOrder
      .map((id) => this.targets.get(id))
      .filter((target): target is BrowserTarget => target !== undefined);
  }

  /**
   * Read-only live workspace snapshot (bridge mode + open tabs). Hosts query
   * this through the runtime service registry so no caller needs a static
   * import edge into this plugin.
   */
  getWorkspaceSnapshot(): Promise<BrowserWorkspaceSnapshot> {
    return getBrowserWorkspaceSnapshot();
  }

  /**
   * Resolve the active target for a command. If `preferredId` is given,
   * returns that target only if available; otherwise scores registered
   * targets and returns the best available one.
   * Returns `null` if nothing is available.
   */
  async resolveTarget(
    preferredId?: string,
    command: BrowserWorkspaceCommand = { subaction: "state" },
  ): Promise<BrowserTarget | null> {
    const targets = await this.resolveTargets(preferredId, command);
    return targets[0] ?? null;
  }

  async resolveTargets(
    preferredId?: string,
    command: BrowserWorkspaceCommand = { subaction: "state" },
  ): Promise<BrowserTarget[]> {
    if (preferredId) {
      const target = this.targets.get(preferredId);
      if (!target) return [];
      try {
        return (await target.available()) ? [target] : [];
      } catch {
        return [];
      }
    }

    const context: BrowserTargetResolutionContext = {
      command,
      env: process.env,
      mobile: isMobileBrowserRuntime(process.env),
    };
    const available: Array<{
      score: number;
      order: number;
      target: BrowserTarget;
    }> = [];

    for (const id of this.targetOrder) {
      const target = this.targets.get(id);
      if (!target) continue;
      try {
        const score = target.score
          ? target.score(context)
          : (target.priority ?? 0);
        if (score === null) continue;
        if (await target.available()) {
          available.push({
            score,
            order: this.targetOrder.indexOf(id),
            target,
          });
        }
      } catch {
        // Ignore unhealthy targets during target resolution.
      }
    }

    return available
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map(({ target }) => target);
  }

  /**
   * Dispatch a command. `targetId` pins the target; otherwise the service
   * picks the first available one in registration order.
   */
  async execute(
    command: BrowserWorkspaceCommand,
    targetId?: string,
  ): Promise<BrowserWorkspaceCommandResult> {
    const targets = await this.resolveTargets(targetId, command);
    if (targets.length === 0) {
      const availableIds = this.targetOrder.join(", ") || "(none)";
      throw new Error(
        targetId
          ? `Browser target "${targetId}" is not available. Registered targets: ${availableIds}.`
          : `No browser target is available. Registered targets: ${availableIds}.`,
      );
    }

    let lastError: unknown = null;
    for (const target of targets) {
      try {
        return await target.execute(command);
      } catch (err) {
        lastError = err;
        if (targetId) break;
        const message = err instanceof Error ? err.message : String(err);
        logger.debug(
          `[BrowserService] target "${target.id}" failed; trying next target: ${message}`,
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Browser target execution failed.");
  }
}

function createWorkspaceTarget(): BrowserTarget {
  return {
    id: "workspace",
    name: "Browser Workspace",
    description:
      "Eliza's electrobun-embedded BrowserView (desktop) or JSDOM fallback (web). Always available.",
    kind: "app",
    priority: 100,
    score: ({ mobile }) => (mobile ? 120 : 100),
    available: async () => true,
    execute: async (command) => {
      const { executeBrowserWorkspaceCommand } = await import(
        "./workspace/browser-workspace.js"
      );
      return executeBrowserWorkspaceCommand(command);
    },
  };
}

async function maybeCreateBridgeTarget(
  runtime: IAgentRuntime,
): Promise<BrowserTarget | null> {
  const service = runtime.getService<BrowserBridgeRouteService>(
    BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  );
  if (!service) return null;
  return {
    id: "bridge",
    name: "Browser Bridge (Chrome / Safari companion)",
    description:
      "Routes commands to the user's real Chrome or Safari via the Agent Browser Bridge companion extension. Subset of subactions supported (open / navigate / close / list / state / show / hide / tab / get).",
    kind: "companion",
    priority: 80,
    score: ({ mobile }) => (mobile ? null : 80),
    available: async () => {
      try {
        const companions = await service.listBrowserCompanions();
        return companions.length > 0;
      } catch {
        return false;
      }
    },
    execute: async (command) => {
      const { dispatchBridgeCommand } = await import(
        "./targets/bridge-target.js"
      );
      return dispatchBridgeCommand(service, command);
    },
  };
}

function isMobileBrowserRuntime(env: NodeJS.ProcessEnv): boolean {
  const platform = (
    env.ELIZA_MOBILE_PLATFORM ??
    env.ELIZA_PLATFORM ??
    env.CAPACITOR_PLATFORM ??
    ""
  ).toLowerCase();
  return platform === "ios" || platform === "android" || platform === "mobile";
}
