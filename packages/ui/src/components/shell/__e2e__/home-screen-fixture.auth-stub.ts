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

export function useAuthStatus(): {
  state: typeof AUTHENTICATED_STATE;
  refetch: () => void;
} {
  return { state: AUTHENTICATED_STATE, refetch: () => undefined };
}
