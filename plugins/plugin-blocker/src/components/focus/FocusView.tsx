/**
 * FocusView — the GUI data wrapper for the Focus / blocker surface.
 *
 * It owns the live website-blocking data (`GET {base}/api/website-blocker`
 * returning a `SelfControlStatus`, the early-release mutation, the load/error
 * state machine, and the settle-chained background poll) and renders the one
 * presentational {@link FocusSpatialView} inside a {@link SpatialSurface}.
 *
 * The default fetcher builds the URL from `client.getBaseUrl()`; tests inject a
 * `fetchStatus` / `releaseBlock` so they stay offline.
 */

import { client } from "@elizaos/ui";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SelfControlStatus } from "../../services/website-blocker/index.ts";
import { type FocusSnapshot, FocusSpatialView } from "./FocusSpatialView.tsx";

interface FocusViewProps {
  /** Test/host injection seam. Defaults to a real `/api/website-blocker` GET. */
  fetchStatus?: () => Promise<SelfControlStatus>;
  /** Test/host injection seam. Defaults to `client.stopWebsiteBlock()`. */
  releaseBlock?: () => Promise<unknown>;
}

async function defaultFetchStatus(): Promise<SelfControlStatus> {
  const response = await fetch(`${client.getBaseUrl()}/api/website-blocker`);
  if (!response.ok) {
    throw new Error(
      `Website blocker status request failed (${response.status}).`,
    );
  }
  return (await response.json()) as SelfControlStatus;
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

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchRef
      .current()
      .then((status) => {
        if (!cancelled) setState({ kind: "ready", status });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load website blocking status.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const release = useCallback(() => {
    setReleasing(true);
    releaseRef
      .current()
      .catch(() => {
        // The follow-up refetch surfaces whatever state the engine is in; a
        // failed release leaves the active block visible rather than hidden.
      })
      .finally(() => {
        setReleasing(false);
        load();
      });
  }, [load]);

  // Initial fetch + settle-chained polling. The first load shows the loading
  // skeleton; thereafter we quietly refresh status in place (no skeleton flash)
  // ~15s after each settle. Chaining off settle (rather than a fixed interval)
  // means an in-flight request never stacks a second timer.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const teardown = load();

    const scheduleQuietRefresh = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        fetchRef
          .current()
          .then((status) => {
            if (!cancelled) setState({ kind: "ready", status });
          })
          .catch(() => {
            // Keep the last good state on a transient failure; the next tick
            // re-attempts.
          })
          .finally(scheduleQuietRefresh);
      }, 15000);
    };
    scheduleQuietRefresh();

    return () => {
      cancelled = true;
      teardown();
      if (timer) clearTimeout(timer);
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
