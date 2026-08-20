/**
 * FocusView — the GUI data wrapper for the Focus / blocker surface.
 *
 * It owns the live website-blocking data (`GET {base}/api/website-blocker`
 * returning a `SelfControlStatus`, the early-release mutation, the load/error
 * state machine, and the background poll) and renders the one
 * presentational {@link FocusSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` render the browser DOM
 * surface today while the retained modality contract stays available for future
 * adapters.
 *
 * The default fetcher builds the URL from `client.getBaseUrl()`; tests inject a
 * `fetchStatus` / `releaseBlock` so they stay offline.
 */

import { client } from "@elizaos/ui/api";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SelfControlStatus } from "../../services/website-blocker/index.ts";
import { type FocusSnapshot, FocusSpatialView } from "./FocusSpatialView.tsx";

interface FocusViewProps {
  /** Test/host injection seam. Defaults to a real `/api/website-blocker` GET. */
  fetchStatus?: (signal?: AbortSignal) => Promise<SelfControlStatus>;
  /** Test/host injection seam. Defaults to `client.stopWebsiteBlock()`. */
  releaseBlock?: () => Promise<unknown>;
}

/** Focus JSON GET is a short UI read — same 15s family as InboxView / HealthView. */
export const FOCUS_VIEW_JSON_TIMEOUT_MS = 15_000;

export async function getFocusJsonWithFetch<T>(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number = FOCUS_VIEW_JSON_TIMEOUT_MS,
  callerSignal?: AbortSignal,
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    method: "GET",
    signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
  });
  if (!response.ok) {
    throw new Error(
      `Website blocker status request failed (${response.status}).`,
    );
  }
  return (await response.json()) as T;
}

async function defaultFetchStatus(
  signal?: AbortSignal,
): Promise<SelfControlStatus> {
  return getFocusJsonWithFetch<SelfControlStatus>(
    `${client.getBaseUrl()}/api/website-blocker`,
    globalThis.fetch,
    FOCUS_VIEW_JSON_TIMEOUT_MS,
    signal,
  );
}

function defaultReleaseBlock(): Promise<unknown> {
  return client.stopWebsiteBlock();
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: SelfControlStatus };

function formatTime(value: string | null | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toSnapshot(state: LoadState, releasing: boolean): FocusSnapshot {
  if (state.kind === "loading") return { phase: "loading" };
  if (state.kind === "error") {
    return { phase: "error", error: state.message };
  }
  const { status } = state;
  if (!status.available) {
    return {
      phase: "unavailable",
      platform: String(status.platform),
      reason: status.reason ?? null,
    };
  }
  if (status.requiresElevation && !status.active) {
    return {
      phase: "permission",
      elevationPromptMethod: status.elevationPromptMethod ?? null,
      reason: status.reason ?? null,
    };
  }
  if (status.active) {
    return {
      phase: "active",
      startedAt: formatTime(status.startedAt),
      endsAt: status.endsAt ? formatTime(status.endsAt) : null,
      matchMode: status.matchMode,
      blockedWebsites: status.blockedWebsites,
      canUnblockEarly: status.canUnblockEarly,
      requiresElevation: status.requiresElevation,
      releasing,
    };
  }
  return { phase: "empty" };
}

export function FocusView({
  fetchStatus = defaultFetchStatus,
  releaseBlock = defaultReleaseBlock,
}: FocusViewProps = {}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [releasing, setReleasing] = useState(false);
  const fetchRef = useRef(fetchStatus);
  fetchRef.current = fetchStatus;
  const releaseRef = useRef(releaseBlock);
  releaseRef.current = releaseBlock;
  const activeLoadRef = useRef<AbortController | null>(null);

  const load = useCallback((background = false) => {
    activeLoadRef.current?.abort();
    const controller = new AbortController();
    activeLoadRef.current = controller;
    if (!background) setState({ kind: "loading" });
    fetchRef
      .current(controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setState({ kind: "ready", status });
      })
      // error-policy:J4 foreground failures render an error; background failures preserve last-good state.
      .catch((error: unknown) => {
        if (controller.signal.aborted || background) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load website blocking status.",
        });
      })
      .finally(() => {
        if (activeLoadRef.current === controller) activeLoadRef.current = null;
      });
  }, []);

  const release = useCallback(() => {
    setReleasing(true);
    releaseRef
      .current()
      // error-policy:J4 the follow-up status read keeps a failed release visible.
      .catch(() => {
        // The follow-up refetch surfaces whatever state the engine is in; a
        // failed release leaves the active block visible rather than hidden.
      })
      .finally(() => {
        setReleasing(false);
        load();
      });
  }, [load]);

  // The initial load surfaces failures; background refreshes preserve the last
  // good state and supersede any request still active at the next interval.
  useEffect(() => {
    load();
    const timer = setInterval(() => load(true), 15_000);
    return () => {
      clearInterval(timer);
      activeLoadRef.current?.abort();
    };
  }, [load]);

  const onAction = useCallback(
    (action: string) => {
      switch (action) {
        case "retry":
          load();
          return;
        case "release":
          release();
          return;
      }
    },
    [load, release],
  );

  const snapshot = toSnapshot(state, releasing);

  return <FocusSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default FocusView;
