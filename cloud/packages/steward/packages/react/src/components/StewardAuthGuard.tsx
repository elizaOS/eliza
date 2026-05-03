import { useAuth } from "../hooks/useAuth.js";
import type { StewardAuthGuardProps } from "../types.js";
import { StewardLogin } from "./StewardLogin.js";

/**
 * StewardAuthGuard — Renders children only when the user is authenticated.
 *
 * While auth is initializing, renders `loadingFallback` (or a default spinner).
 * When unauthenticated, renders `fallback` (or a default `<StewardLogin />`).
 *
 * @example
 * <StewardAuthGuard>
 *   <ProtectedApp />
 * </StewardAuthGuard>
 *
 * @example
 * <StewardAuthGuard
 *   fallback={<CustomLoginPage />}
 *   loadingFallback={<Spinner />}
 * >
 *   <Dashboard />
 * </StewardAuthGuard>
 */
export function StewardAuthGuard({ children, fallback, loadingFallback }: StewardAuthGuardProps) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="stwd-auth-guard stwd-auth-guard__loading">
        {loadingFallback ?? <div className="stwd-loading">Loading…</div>}
      </div>
    );
  }

  if (!isAuthenticated) {
    return <div className="stwd-auth-guard">{fallback ?? <StewardLogin />}</div>;
  }

  return <>{children}</>;
}
