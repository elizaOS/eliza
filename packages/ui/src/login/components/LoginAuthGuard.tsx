/** Renders protected content only after authentication resolves and a session is available. */
import { useAuth } from "../hooks/useAuth.js";
import type { LoginAuthGuardProps } from "../types.js";
import { LoginForm } from "./LoginForm.js";

/**
 * LoginAuthGuard — Renders children only when the user is authenticated.
 *
 * While auth is initializing, renders `loadingFallback` (or a default spinner).
 * When unauthenticated, renders `fallback` (or a default `<LoginForm />`).
 *
 * @example
 * <LoginAuthGuard>
 *   <ProtectedApp />
 * </LoginAuthGuard>
 *
 * @example
 * <LoginAuthGuard
 *   fallback={<CustomLoginPage />}
 *   loadingFallback={<Spinner />}
 * >
 *   <Dashboard />
 * </LoginAuthGuard>
 */
export function LoginAuthGuard({
  children,
  fallback,
  loadingFallback,
}: LoginAuthGuardProps) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="stwd-auth-guard stwd-auth-guard__loading">
        {loadingFallback ?? <div className="stwd-loading">Loading…</div>}
      </div>
    );
  }

  if (!isAuthenticated) {
    return <div className="stwd-auth-guard">{fallback ?? <LoginForm />}</div>;
  }

  return <>{children}</>;
}
