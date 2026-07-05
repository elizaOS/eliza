/**
 * Dev-gated onboarding replay (#14382).
 *
 * **Problem:** a fully-onboarded agent can't re-run onboarding for QA without
 * `POST /api/agent/reset`, which is *destructive* — it calls
 * `clearCompatPgliteDataDir` and wipes conversations, knowledge, and
 * trajectories (see `packages/app-core/src/api/server.ts` agent-reset hop). So
 * developers simply never re-test onboarding on their real agent.
 *
 * **This mechanism** re-runs onboarding **without touching any server state**:
 * it installs the existing, already-tested non-destructive client overlay
 * (`installForceFreshFirstRunClientPatch`) which makes the client *report*
 * `firstRunStatus.complete = false` and `getConfig() = {}` for the duration of
 * the replay. The real `eliza.json`, the PGlite data dir, and all memories are
 * untouched — nothing is deleted, no reset endpoint is called. When the replay
 * onboarding is submitted (or the flag is dropped), the overlay lifts and the
 * real agent is exactly as it was.
 *
 * **Safety invariants (enforced + tested in `onboarding-replay.test.ts`):**
 *  1. Gated to dev builds only (`import.meta.env.DEV`) — never active in prod.
 *  2. Never calls `client.deleteAgent` / `POST /api/agent/reset` / any wipe.
 *  3. Never clears the persisted active-server (unlike the `?reset` escape
 *     hatch) — the replay points at the *same* real agent, it just re-shows
 *     onboarding on top of it.
 *  4. Purely additive overlay: uninstalling it restores the original client
 *     methods verbatim.
 *
 * **Entry:** append `?onboarding-replay=1` to the dev URL. This is intentionally
 * distinct from the destructive `?reset` param (which clears active-server and
 * force-fresh flags) — replay is the *safe* path for QA on a real agent.
 *
 * **On submit:** walking the replayed onboarding is fully non-destructive. If a
 * developer *submits* the replayed onboarding, the real `submitFirstRun` runs
 * (that's the point — it exercises the full flow), which re-applies the chosen
 * onboarding *config* to the agent. That updates onboarding config only; it does
 * NOT delete the PGlite data dir / conversations / knowledge — those are wiped
 * exclusively by `POST /api/agent/reset`, which this mechanism never calls. To
 * inspect without applying, walk the steps and drop the flag before submitting.
 */

import {
  enableForceFreshFirstRun,
  installForceFreshFirstRunClientPatch,
} from "./first-run-reset";
import type { FirstRunClientLike, StorageLike } from "./types";

export const ONBOARDING_REPLAY_QUERY_PARAM = "onboarding-replay";

/** In-memory replay flag key (session-scoped; NOT the durable force-fresh key). */
const REPLAY_SESSION_KEY = "elizaos:onboarding-replay:active";

/**
 * True only in a dev build. Prod bundles set `import.meta.env.DEV` to `false`,
 * so this whole mechanism is compiled out of the user-facing surface.
 */
export function isOnboardingReplaySupported(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

function getSearchParams(url?: URL | null): URLSearchParams | null {
  if (url) {
    return url.searchParams;
  }
  if (typeof window === "undefined") {
    return null;
  }
  return new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
}

/**
 * True when the current URL requests an onboarding replay AND the build allows
 * it. Prod builds always return false regardless of the query param.
 */
export function isOnboardingReplayRequested(url?: URL | null): boolean {
  if (!isOnboardingReplaySupported()) {
    return false;
  }
  const params = getSearchParams(url);
  if (!params) {
    return false;
  }
  const raw = params.get(ONBOARDING_REPLAY_QUERY_PARAM);
  return raw === "1" || raw === "true";
}

/**
 * Result of arming a replay. `active: false` means the replay was not requested
 * or not supported (prod) — the caller should do nothing. When `active: true`,
 * `uninstall()` lifts the overlay and restores the real client verbatim.
 */
export interface OnboardingReplayHandle {
  active: boolean;
  uninstall: () => void;
}

const NOOP_HANDLE: OnboardingReplayHandle = {
  active: false,
  uninstall: () => {},
};

/**
 * Arms a non-destructive onboarding replay if requested by the URL and allowed
 * by the build. Composes the existing force-fresh client overlay; performs NO
 * destructive action (no reset endpoint, no active-server clear, no storage
 * wipe). Returns a handle whose `uninstall()` fully restores the client.
 *
 * @param client the first-run-capable API client to overlay
 * @param opts.url  optional URL (defaults to `window.location`)
 * @param opts.storage optional storage shim (defaults to `window.localStorage`)
 */
export function armOnboardingReplay(
  client: FirstRunClientLike,
  opts?: { url?: URL | null; storage?: StorageLike | null },
): OnboardingReplayHandle {
  if (!isOnboardingReplayRequested(opts?.url)) {
    return NOOP_HANDLE;
  }

  // Mark the session as in-replay for any UI that wants a "replay" badge.
  // Session-scoped and best-effort: never durable, never a prod footgun.
  try {
    const storage =
      opts?.storage ??
      (typeof window !== "undefined" ? window.sessionStorage : null);
    storage?.setItem(REPLAY_SESSION_KEY, "1");
  } catch {
    // Ignore storage failures — the overlay is the source of truth.
  }

  // Deliberately use a throwaway storage so the overlay's force-fresh read/write
  // is scoped to replay and never mutates the durable
  // `elizaos:first-run:force-fresh` restore key used by the ?reset path. Enable
  // the flag in that ephemeral storage so the overlay actually reports fresh.
  const ephemeralStorage = createEphemeralStorage();
  enableForceFreshFirstRun(ephemeralStorage);
  const uninstallPatch = installForceFreshFirstRunClientPatch(
    client,
    ephemeralStorage,
  );

  return {
    active: true,
    uninstall: () => {
      uninstallPatch();
      try {
        const storage =
          opts?.storage ??
          (typeof window !== "undefined" ? window.sessionStorage : null);
        storage?.removeItem(REPLAY_SESSION_KEY);
      } catch {
        // Ignore.
      }
    },
  };
}

/**
 * A tiny in-memory `StorageLike` so the replay overlay's internal force-fresh
 * flag never touches real localStorage / the durable restore path.
 */
function createEphemeralStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
