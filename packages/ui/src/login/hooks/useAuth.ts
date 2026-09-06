/** Exposes authenticated account state and login operations from the enclosing provider. */
import { useContext } from "react";
import { LoginAuthContext } from "../provider.js";
import type { LoginAuthContextValue } from "../types.js";

/**
 * Access elizaOS auth state and methods.
 * Must be used inside <LoginProvider> with `auth` prop configured.
 *
 * @example
 * const { isAuthenticated, user, signOut, isLoading } = useAuth();
 */
export function useAuth(): LoginAuthContextValue {
  const ctx = useContext(LoginAuthContext);
  if (!ctx) {
    throw new Error(
      "useAuth must be used within a <LoginProvider> with an `auth` prop.",
    );
  }
  return ctx;
}
