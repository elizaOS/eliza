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
 *
 * Anyone can add a new target later by calling `registerTarget` — that's
 * the whole point of the pattern. The BROWSER action stays one action.
 */

import {
  type IAgentRuntime,
  logger,
  Service,
} from "@elizaos/core";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "./service.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "./workspace/browser-workspace-types.js";

export const BROWSER_SERVICE_TYPE = "browser";

/**
 * Pluggable browser backend. Implementations translate the canonical
 * BrowserWorkspaceCommand surface into whatever native shape they speak
 * (electrobun bridge, Chrome companion HTTP, puppeteer CDP, etc.) and
 * return the canonical BrowserWorkspaceCommandResult.
 *
 * Targets MAY decline subactions they don't support — throw a clear
 * `Error` from `execute` and the caller will see the message. Don't
 * silently no-op.
 */
export interface BrowserTarget {
  /** Stable identifier — `workspace`, `bridge`, `computeruse`, etc. */
  readonly id: string;
  /** Short human-readable name for diagnostics. */
  readonly name: string;
  /** One-line description of what this target controls. */
  readonly description: string;
  /**
   * Cheap availability check. Called when the BROWSER action wants to
   * route a command and the caller didn't pin a target. Should be fast
   * (no network round-trips) when possible.
   */
  available(): Promise<boolean>;
  /** Run the command. Throw on unsupported subactions. */
  execute(command: BrowserWorkspaceCommand): Promise<BrowserWorkspaceCommandResult>;
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
    // implementor) are reachable via the runtime; we attempt registration here
    // and silently skip if unavailable, so the agent can still boot in
    // workspace-only mode.
    try {
      const bridgeTarget = await maybeCreateBridgeTarget(runtime);
      if (bridgeTarget) service.registerTarget(bridgeTarget);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(
        `[BrowserService] bridge target not registered at start: ${message}`,
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
   * Resolve the active target for a command. If `preferredId` is given,
   * returns that target only if available; otherwise scans registered
   * targets in registration order and returns the first available one.
   * Returns `null` if nothing is available.
   */
  async resolveTarget(preferredId?: string): Promise<BrowserTarget | null> {
    if (preferredId) {
      const target = this.targets.get(preferredId);
      if (!target) return null;
      try {
        return (await target.available()) ? target : null;
      } catch {
        return null;
      }
    }
    for (const id of this.targetOrder) {
      const target = this.targets.get(id);
      if (!target) continue;
      try {
        if (await target.available()) return target;
      } catch {
        // skip unhealthy targets
      }
    }
    return null;
  }

  /**
   * Dispatch a command. `targetId` pins the target; otherwise the service
   * picks the first available one in registration order.
   */
  async execute(
    command: BrowserWorkspaceCommand,
    targetId?: string,
  ): Promise<BrowserWorkspaceCommandResult> {
    const target = await this.resolveTarget(targetId);
    if (!target) {
      const availableIds = this.targetOrder.join(", ") || "(none)";
      throw new Error(
        targetId
          ? `Browser target "${targetId}" is not available. Registered targets: ${availableIds}.`
          : `No browser target is available. Registered targets: ${availableIds}.`,
      );
    }
    return target.execute(command);
  }
}

function createWorkspaceTarget(): BrowserTarget {
  return {
    id: "workspace",
    name: "Browser Workspace",
    description:
      "Eliza's electrobun-embedded BrowserView (desktop) or JSDOM fallback (web). Always available.",
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
