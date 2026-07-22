/**
 * Keeps the agent's client-scoped active-view context synchronized with the
 * shell that owns the pixels. The shell publishes its already-visible route or
 * layout after a document load, after reconnect, and immediately before a chat
 * turn so a restarted backend cannot plan against an empty or stale view.
 */

import { ElizaError } from "@elizaos/core";
import { client } from "./api";

export interface AuthoritativeShellViewState {
  viewId: string;
  viewPath: string;
  viewType: "gui" | "tui" | "xr";
  mode?: "split" | "tile";
  panes?: Array<{
    viewId: string;
    viewType: "gui" | "tui" | "xr";
  }>;
  layout?: string;
  placement?: string;
}

type ViewStateRequest = (
  path: string,
  init: RequestInit,
  options: { allowNonOk: true },
) => Promise<Response>;

interface PublishDependencies {
  request?: ViewStateRequest;
}

interface ReadinessWaiter {
  resolve: () => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const AUTHORITATIVE_STATE_READY_TIMEOUT_MS = 5_000;

let authoritativeState: AuthoritativeShellViewState | null = null;
let authoritativeStatePending = false;
const readinessWaiters = new Set<ReadinessWaiter>();
let publicationTail: Promise<void> = Promise.resolve();

function normalizedState(
  state: AuthoritativeShellViewState,
): AuthoritativeShellViewState {
  const panes = state.panes?.map((pane) => ({ ...pane }));
  return {
    ...state,
    ...(panes ? { panes } : {}),
  };
}

/** Replace the shell snapshot used by the next reconnect or chat-send barrier. */
export function setAuthoritativeShellViewState(
  state: AuthoritativeShellViewState | null,
  options: {
    /** The visible route/layout is known, but its exact registry metadata is not. */
    pending?: boolean;
  } = {},
): void {
  authoritativeState = state ? normalizedState(state) : null;
  authoritativeStatePending = state === null && options.pending === true;
  if (authoritativeStatePending) return;
  for (const waiter of readinessWaiters) {
    clearTimeout(waiter.timeoutId);
    waiter.resolve();
  }
  readinessWaiters.clear();
}

function waitForAuthoritativeStateReadiness(): Promise<void> {
  if (!authoritativeStatePending) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const waiter: ReadinessWaiter = {
      resolve,
      timeoutId: setTimeout(() => {
        readinessWaiters.delete(waiter);
        reject(
          new ElizaError(
            "Shell view registry did not become ready before chat send",
            {
              code: "VIEW_SHELL_STATE_NOT_READY",
              context: {
                timeoutMs: AUTHORITATIVE_STATE_READY_TIMEOUT_MS,
              },
            },
          ),
        );
      }, AUTHORITATIVE_STATE_READY_TIMEOUT_MS),
    };
    readinessWaiters.add(waiter);
  });
}

function publishBody(
  state: AuthoritativeShellViewState,
): Record<string, unknown> {
  const panes = state.panes?.length ? state.panes : undefined;
  const viewIds = panes?.map((pane) => pane.viewId);
  const viewTypes = panes
    ? Object.fromEntries(panes.map((pane) => [pane.viewId, pane.viewType]))
    : undefined;
  return {
    source: "user",
    rehydrate: true,
    path: state.viewPath,
    viewType: state.viewType,
    ...(state.mode
      ? { action: state.mode === "split" ? "split-view" : "tile-views" }
      : {}),
    ...(viewIds ? { views: viewIds, viewTypes } : {}),
    ...(state.layout ? { layout: state.layout } : {}),
    ...(state.placement ? { placement: state.placement } : {}),
  };
}

async function postAuthoritativeState(
  state: AuthoritativeShellViewState,
  dependencies: PublishDependencies,
): Promise<boolean> {
  const request = dependencies.request ?? client.rawRequest.bind(client);
  const response = await request(
    `/api/views/${encodeURIComponent(state.viewId)}/navigate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(publishBody(state)),
    },
    { allowNonOk: true },
  );
  if (response.ok) return true;
  // Limited/older agent surfaces may intentionally omit the shell registry.
  if (response.status === 404 || response.status === 501) return false;
  throw new ElizaError(
    `Shell view rehydrate returned HTTP ${response.status}`,
    {
      code: "VIEW_SHELL_REHYDRATE_FAILED",
      context: { status: response.status, viewId: state.viewId },
    },
  );
}

/**
 * Publish the latest shell snapshot in-order. Serialization prevents an older
 * reload request from racing a newer route/layout snapshot and winning last.
 */
export function rehydrateAuthoritativeShellViewState(
  dependencies: PublishDependencies = {},
): Promise<boolean> {
  const snapshot = authoritativeState
    ? normalizedState(authoritativeState)
    : null;
  if (!snapshot) return Promise.resolve(false);

  const publication = publicationTail.then(() =>
    postAuthoritativeState(snapshot, dependencies),
  );
  // error-policy:J5 callers observe the returned `publication`; only the
  // serialization tail absorbs rejection so a failed publish cannot poison
  // every later route snapshot queued behind it.
  publicationTail = publication.then(
    () => undefined,
    () => undefined,
  );
  return publication;
}

/** Chat-send barrier: current shell context reaches the backend before the turn. */
export function ensureAuthoritativeShellViewState(
  dependencies: PublishDependencies = {},
): Promise<boolean> {
  return waitForAuthoritativeStateReadiness().then(() =>
    rehydrateAuthoritativeShellViewState(dependencies),
  );
}

export function __resetAuthoritativeShellViewStateForTests(): void {
  authoritativeState = null;
  authoritativeStatePending = false;
  for (const waiter of readinessWaiters) {
    clearTimeout(waiter.timeoutId);
    waiter.resolve();
  }
  readinessWaiters.clear();
  publicationTail = Promise.resolve();
}
