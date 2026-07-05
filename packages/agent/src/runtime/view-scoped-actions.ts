/**
 * View-scoped agent actions: turns a view's `ViewScopedAction` declarations into
 * real runtime actions that are gated on the declaring view being foreground.
 *
 * A scoped action's `validate()` returns false unless the declaring view is the
 * active view (read from the same authoritative active-view context the affinity
 * map uses via view-action-affinity.ts) — so the agent cannot invoke a wallet
 * action while sitting in Settings, and a view switch flips availability without
 * a restart. The handler expands the declaration's `steps` into the view's
 * EXISTING agent-surface interact sequence (`agent-fill`/`agent-click`/
 * `agent-focus` against `useAgentElement` ids), dispatched through the shared
 * `dispatchViewInteract` in views-routes.ts — there is no parallel DOM-driving
 * path. A step whose target `useAgentElement` id is not mounted fails loudly
 * with a typed {@link ElizaError} (`VIEW_SCOPED_ACTION_ELEMENT_MISSING`), never
 * a silent no-op.
 *
 * plugin-lifecycle registers these when a view's plugin loads and unregisters
 * them on unload/reload; builtin views register theirs at server boot. This is
 * the mechanism only — per-view children declare the concrete actions.
 */

import {
  type Action,
  type ActionResult,
  ElizaError,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
  type ViewScopedAction,
  type ViewScopedActionStep,
} from "@elizaos/core";
import { getView } from "../api/views-registry.ts";
import {
  dispatchViewInteract,
  getViewsBroadcastWs,
} from "../api/views-routes.ts";
import { getActiveViewContext } from "./view-action-affinity.ts";

/** How long a single agent-surface step waits for the frontend to resolve. */
const SCOPED_ACTION_STEP_TIMEOUT_MS = 5_000;

/** Whole-string `{{paramName}}` token; the token must be the entire value. */
const PARAM_TOKEN = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/**
 * Read the action parameters the planner passes. The runtime nests validated
 * params under `options.parameters` (the #10677 contract); fall back to the flat
 * `options` object for direct/test callers. Returns an empty object when absent.
 */
function readActionParams(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  const nested = record.parameters;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return record;
}

/**
 * Resolve a step's fill value: a bare `{{param}}` token pulls that parameter,
 * anything else is a literal. Throws a typed error when a referenced parameter
 * is missing rather than filling an empty/placeholder value into the control.
 */
function resolveStepValue(
  step: ViewScopedActionStep,
  params: Record<string, unknown>,
  actionName: string,
): string {
  const raw = step.value ?? "";
  const match = PARAM_TOKEN.exec(raw.trim());
  if (!match) return raw;
  const key = match[1];
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    throw new ElizaError(
      `View-scoped action "${actionName}" step fills "${step.target}" from parameter "${key}", which was not provided`,
      {
        code: "VIEW_SCOPED_ACTION_PARAM_MISSING",
        context: { actionName, target: step.target, parameter: key },
        severity: "ephemeral",
      },
    );
  }
  return String(value);
}

/** Map a declared step to its interact capability + params payload. */
function stepToCapability(
  step: ViewScopedActionStep,
  params: Record<string, unknown>,
  actionName: string,
): { capability: string; params: Record<string, unknown> } {
  switch (step.kind) {
    case "agent-fill":
      return {
        capability: "agent-fill",
        params: {
          id: step.target,
          value: resolveStepValue(step, params, actionName),
        },
      };
    case "agent-click":
      return { capability: "agent-click", params: { id: step.target } };
    case "agent-focus":
      return { capability: "agent-focus", params: { id: step.target } };
  }
}

/**
 * True when an interact dispatch result signals the target element was not
 * mounted. The agent-surface registry does not throw for a missing id — it
 * returns `{ ok: false, reason: "element not found" | "element not mounted" }`,
 * which the frontend relays as a SUCCESSFUL interact carrying that payload. So a
 * missing element reads as `dispatch.success === true` with `result.ok === false`;
 * detect it here so the handler can throw loudly instead of reporting success.
 */
function isMissingElementResult(result: unknown): boolean {
  const payload = unwrapInteractResult(result);
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  if (record.ok !== false) return false;
  const reason = typeof record.reason === "string" ? record.reason : "";
  return /not found|not mounted/i.test(reason);
}

/** The reason string from a `{ ok: false, reason }` agent-surface result, if any. */
function failureReason(result: unknown): string | undefined {
  const payload = unwrapInteractResult(result);
  if (!payload || typeof payload !== "object") return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Peel the interact envelope down to the agent-surface `AgentActionResult`. The
 * frontend round-trip wraps it as `{ success, result: <payload> }`; a direct
 * `serverInteract` returns the payload itself. Handle both.
 */
function unwrapInteractResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  return "result" in record ? record.result : record;
}

/**
 * Build a runtime {@link Action} from a view's scoped-action declaration.
 *
 * @param viewId - the declaring view's id (the active-view gate).
 * @param decl   - the scoped-action declaration.
 */
export function buildViewScopedAction(
  viewId: string,
  decl: ViewScopedAction,
): Action {
  const paramList = decl.parameters ?? [];
  const paramLine =
    paramList.length > 0 ? ` (parameters: ${paramList.join(", ")})` : "";

  return {
    name: decl.name,
    description: decl.description,
    similes: decl.similes,
    routingHint: `only available while the "${viewId}" view is active -> ${decl.name}${paramLine}; drives that view's controls, unavailable elsewhere`,
    // The declaring view must be the FOREGROUND active view. This is the gate
    // that keeps the agent from driving a view's controls while looking at a
    // different one; a view switch (POST /api/views/:id/navigate) re-stamps the
    // active context and flips this without a restart.
    validate: async (): Promise<boolean> => {
      return getActiveViewContext()?.viewId === viewId;
    },
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state?: State,
      options?: unknown,
    ): Promise<ActionResult> => {
      // Defense in depth: the executor already gates on validate(), but a
      // hallucinated direct call must not drive a background view's controls.
      const active = getActiveViewContext();
      if (active?.viewId !== viewId) {
        throw new ElizaError(
          `View-scoped action "${decl.name}" requires the "${viewId}" view to be active (active view: ${active?.viewId ?? "none"})`,
          {
            code: "VIEW_SCOPED_ACTION_VIEW_INACTIVE",
            context: {
              actionName: decl.name,
              requiredView: viewId,
              activeView: active?.viewId ?? null,
            },
            severity: "ephemeral",
          },
        );
      }

      const broadcastWs = getViewsBroadcastWs();
      const entry = getView(viewId, { viewType: active.viewType });
      // A scoped action drives a MOUNTED view surface. With no way to reach a
      // shell (no server-side handler and no WS broadcaster), the dispatch would
      // block on the pending-request timeout and then read as a plain failure —
      // fail loudly instead so the missing wiring surfaces to the agent.
      if (!entry?.serverInteract && !broadcastWs) {
        throw new ElizaError(
          `View-scoped action "${decl.name}" cannot reach the "${viewId}" view: no mounted shell to dispatch to`,
          {
            code: "VIEW_SCOPED_ACTION_NO_SHELL",
            context: { actionName: decl.name, viewId },
            severity: "ephemeral",
          },
        );
      }
      if (!entry) {
        throw new ElizaError(
          `View-scoped action "${decl.name}" references view "${viewId}" which is not registered`,
          {
            code: "VIEW_SCOPED_ACTION_VIEW_UNREGISTERED",
            context: { actionName: decl.name, viewId },
            severity: "fatal",
          },
        );
      }

      const params = readActionParams(options);
      const driven: string[] = [];

      for (const step of decl.steps) {
        const { capability, params: stepParams } = stepToCapability(
          step,
          params,
          decl.name,
        );
        const dispatch = await dispatchViewInteract(
          entry,
          viewId,
          capability,
          stepParams,
          broadcastWs ?? undefined,
          SCOPED_ACTION_STEP_TIMEOUT_MS,
        );

        if (isMissingElementResult(dispatch.result)) {
          throw new ElizaError(
            `View-scoped action "${decl.name}" targets element "${step.target}" in view "${viewId}", which is not mounted`,
            {
              code: "VIEW_SCOPED_ACTION_ELEMENT_MISSING",
              context: {
                actionName: decl.name,
                viewId,
                target: step.target,
                capability,
              },
              severity: "ephemeral",
            },
          );
        }
        if (!dispatch.success) {
          const reason = dispatch.error ?? failureReason(dispatch.result);
          throw new ElizaError(
            `View-scoped action "${decl.name}" step ${capability} on "${step.target}" failed${reason ? `: ${reason}` : ""}`,
            {
              code: "VIEW_SCOPED_ACTION_STEP_FAILED",
              context: {
                actionName: decl.name,
                viewId,
                target: step.target,
                capability,
                reason,
              },
              severity: "ephemeral",
            },
          );
        }
        driven.push(`${capability}:${step.target}`);
      }

      logger.info(
        { src: "ViewScopedActions", actionName: decl.name, viewId, driven },
        `[ViewScopedActions] "${decl.name}" drove ${driven.length} step(s) on view "${viewId}"`,
      );

      const text = `Ran "${decl.name}" on the ${entry.label} view (${driven.length} step${driven.length === 1 ? "" : "s"}).`;
      return {
        success: true,
        text,
        userFacingText: text,
        data: { viewId, actionName: decl.name, steps: driven },
      };
    },
  };
}

/**
 * Names of the scoped actions a view declares. Used to reconcile the runtime
 * registry on plugin reload (unregister the previous set before registering the
 * new one) and to surface the view's named actions to the awareness block.
 */
export function scopedActionNames(
  scopedActions: readonly ViewScopedAction[] | undefined,
): string[] {
  if (!scopedActions) return [];
  return [
    ...new Set(scopedActions.map((a) => a.name.trim()).filter(Boolean)),
  ];
}

/** A view (any modality) that can carry scoped-action declarations. */
interface ScopedActionSourceView {
  id: string;
  scopedActions?: ViewScopedAction[];
}

/**
 * Per-owner action objects currently registered in the runtime, so a
 * reload/unload can remove exactly the previously-registered set without
 * touching another owner's actions. Keyed by the owner passed to
 * {@link registerViewScopedActions} (plugin name, or "@elizaos/builtin").
 */
const registeredByOwner = new Map<string, Map<string, Action>>();

type ScopedActionRuntime = Pick<
  IAgentRuntime,
  "registerAction" | "unregisterAction"
> &
  Partial<Pick<IAgentRuntime, "actions">>;

function findRuntimeAction(
  runtime: Pick<IAgentRuntime, "actions">,
  name: string,
): Action | undefined {
  return runtime.actions.find((action) => action.name === name);
}

function unregisterOwnedScopedActions(
  runtime: ScopedActionRuntime,
  owner: string,
): void {
  const previous = registeredByOwner.get(owner);
  if (!previous) return;
  if (!Array.isArray(runtime.actions)) {
    logger.warn(
      { src: "ViewScopedActions", owner },
      `[ViewScopedActions] cannot prove scoped-action ownership for owner "${owner}" during unregister; leaving actions registered`,
    );
    registeredByOwner.delete(owner);
    return;
  }
  for (const [name, action] of previous) {
    if (
      findRuntimeAction(runtime as Pick<IAgentRuntime, "actions">, name) !==
      action
    ) {
      logger.warn(
        { src: "ViewScopedActions", owner, actionName: name },
        `[ViewScopedActions] scoped action "${name}" for owner "${owner}" is no longer installed by that owner; skipping unregister`,
      );
      continue;
    }
    runtime.unregisterAction(name);
  }
  registeredByOwner.delete(owner);
}

/**
 * Reconcile the runtime action registry with the scoped actions declared by
 * `owner`'s views: unregister the owner's previously-registered scoped actions,
 * then register the current set. Idempotent — safe to call on every plugin
 * (re)load. A duplicate action name across views is registered once (first
 * wins) and warned, since the runtime registry is keyed by name.
 *
 * @returns the scoped-action names now registered for this owner.
 */
export function registerViewScopedActions(
  runtime: ScopedActionRuntime,
  owner: string,
  views: readonly ScopedActionSourceView[],
): string[] {
  unregisterOwnedScopedActions(runtime, owner);

  const registered = new Map<string, Action>();
  for (const view of views) {
    const scopedActions = view.scopedActions;
    if (!scopedActions) continue;
    for (const decl of scopedActions) {
      const name = decl.name.trim();
      if (!name) continue;
      if (registered.has(name)) {
        logger.warn(
          {
            src: "ViewScopedActions",
            owner,
            viewId: view.id,
            actionName: name,
          },
          `[ViewScopedActions] duplicate scoped-action name "${name}" for owner "${owner}" — keeping first`,
        );
        continue;
      }
      const action = buildViewScopedAction(view.id, decl);
      runtime.registerAction(action);
      if (
        Array.isArray(runtime.actions) &&
        findRuntimeAction(runtime as Pick<IAgentRuntime, "actions">, name) !==
          action
      ) {
        logger.warn(
          {
            src: "ViewScopedActions",
            owner,
            viewId: view.id,
            actionName: name,
          },
          `[ViewScopedActions] scoped-action name "${name}" for owner "${owner}" conflicts with an existing action — keeping incumbent`,
        );
        continue;
      }
      registered.set(name, action);
    }
  }

  if (registered.size > 0) {
    registeredByOwner.set(owner, registered);
    logger.info(
      { src: "ViewScopedActions", owner, count: registered.size },
      `[ViewScopedActions] registered ${registered.size} scoped action(s) for owner "${owner}"`,
    );
  } else {
    registeredByOwner.delete(owner);
  }
  return [...registered.keys()];
}

/** Unregister all scoped actions registered for `owner` (plugin unload). */
export function unregisterViewScopedActions(
  runtime: ScopedActionRuntime,
  owner: string,
): void {
  unregisterOwnedScopedActions(runtime, owner);
}

/** Test-only: forget all owner→action bookkeeping (does not touch a runtime). */
export function __resetViewScopedActionRegistryForTests(): void {
  registeredByOwner.clear();
}
