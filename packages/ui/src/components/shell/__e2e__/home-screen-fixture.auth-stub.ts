/**
 * Auth stub for the home-screen fixture bundle.
 *
 * The fixture renders the REAL widget components, and since #11084
 * (#11107/#11122) every home/sidebar widget poller gates on
 * `useIsAuthenticated()` before fetching. The fixture has no auth backend, so
 * without this stub the shared auth snapshot stays in the "loading" phase
 * forever, no gated widget ever fetches its injected data, and every
 * per-plugin card self-hides — the harness then can't prove the real widgets
 * parse the seeded data. Render as an authenticated local session instead;
 * the data still flows through the stubbed client/window.fetch transport.
 */

const AUTHENTICATED_STATE = {
  phase: "authenticated" as const,
  identity: {
    id: "fixture-owner",
    displayName: "Fixture Owner",
    kind: "owner" as const,
  },
  session: { id: "fixture-session", kind: "local" as const, expiresAt: null },
  access: {
    mode: "local" as const,
    passwordConfigured: false,
    ownerConfigured: true,
  },
};

export function useIsAuthenticated(): boolean {
  return true;
}

/**
 * Non-hook auth reads the notification store consults from its module seam
 * (#16242). The fixture is a resolved authenticated snapshot with no
 * transitions, so `isAuthenticatedNow()` is always true and the store hydrates
 * without ever re-arming on `subscribeAuthStatus` — but both exports must exist
 * here or the aliased e2e bundle fails to resolve the store's imports.
 */
export function isAuthenticatedNow(): boolean {
  return true;
}

export function subscribeAuthStatus(
  _listener: (state: typeof AUTHENTICATED_STATE) => void,
): () => void {
  return () => {};
}

export function useAuthStatus(): {
  state: typeof AUTHENTICATED_STATE;
  refetch: () => void;
} {
  return { state: AUTHENTICATED_STATE, refetch: () => undefined };
}

/**
 * No-op prime probe. The real `useAuthStatus` module (#15249) exposes
 * `primeAuthStatusProbe()` to overlap the auth probe with boot hydration;
 * `startup-phase-restore.ts` calls it, and the fixture bundle aliases this stub
 * in for that module — so the export must exist here or the e2e build fails to
 * resolve it. There is nothing to prime: the stub is already a resolved
 * authenticated snapshot (never the `loading` phase the real probe races), so
 * priming is inherently a no-op.
 */
export function primeAuthStatusProbe(): void {}
