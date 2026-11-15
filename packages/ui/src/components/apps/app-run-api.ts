/**
 * Probes whether the connected agent serves the app run API
 * (`/api/apps/launch`, `/api/apps/runs/*`). No handler for it ships in this
 * tree — the route table reserves those slugs and declines them — so launch and
 * run surfaces must check this before posting a launch, and render an
 * unsupported state when it is absent. A host with an external app manager
 * that answers `GET /api/apps/runs` is detected as supported.
 */

import { useEffect, useState } from "react";
import { isApiError } from "../../api/api-error";
import { supportsFullAppShellRoutes } from "../../api/app-shell-capabilities";
import { client } from "../../api/client";
import { useActiveAgentAuthority } from "../../hooks/useActiveAgentAuthority";

export type AppRunApiSupport = "probing" | "supported" | "unsupported";

export const APP_RUN_API_UNSUPPORTED_MESSAGE = "This agent can't run apps.";

// Statuses that mean the route is not served at all, as opposed to a
// transient failure of a route that exists.
const ROUTE_ABSENT_STATUSES = new Set([404, 405, 501]);

const settled = new Map<string, boolean>();
const inflight = new Map<string, Promise<boolean>>();

function probeKey(): string {
  return client.getBaseUrl() ?? "";
}

/**
 * Resolve whether the active agent serves the run API. A definite answer is
 * cached per API base; a transient error is not cached and reads as supported
 * so a flaky network never hides surfaces a working host provides.
 */
export function probeAppRunApi(): Promise<boolean> {
  const key = probeKey();
  if (!supportsFullAppShellRoutes(key)) return Promise.resolve(false);
  const known = settled.get(key);
  if (known !== undefined) return Promise.resolve(known);
  const existing = inflight.get(key);
  if (existing) return existing;
  const probe = client
    .listAppRuns()
    .then(
      () => {
        settled.set(key, true);
        return true;
      },
      (err: unknown) => {
        const status = isApiError(err) ? err.status : undefined;
        if (status !== undefined && ROUTE_ABSENT_STATUSES.has(status)) {
          settled.set(key, false);
          return false;
        }
        return true;
      },
    )
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, probe);
  return probe;
}

/** Synchronous read of a settled probe, or null while unknown. */
function readSettledAppRunApi(): boolean | null {
  const key = probeKey();
  if (!supportsFullAppShellRoutes(key)) return false;
  return settled.get(key) ?? null;
}

export function useAppRunApiSupport(): AppRunApiSupport {
  // Re-probe when the client is repointed at another agent.
  const authority = useActiveAgentAuthority();
  const [probed, setProbed] = useState<{
    authority: string;
    supported: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void probeAppRunApi().then((supported) => {
      if (!cancelled) setProbed({ authority, supported });
    });
    return () => {
      cancelled = true;
    };
  }, [authority]);
  const known =
    probed?.authority === authority ? probed.supported : readSettledAppRunApi();
  if (known === null) return "probing";
  return known ? "supported" : "unsupported";
}

/** Test hook: forget cached probe results. */
export function resetAppRunApiProbeForTests(): void {
  settled.clear();
  inflight.clear();
}
