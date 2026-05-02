import { useContext } from "react";
import { StewardAuthContext } from "../provider.js";
import type { StewardAuthContextValue } from "../types.js";

/**
 * Access Steward auth state and methods.
 * Must be used inside <StewardProvider> with `auth` prop configured.
 *
 * @example
 * const { isAuthenticated, user, signOut, isLoading } = useAuth();
 */
export function useAuth(): StewardAuthContextValue {
  const ctx = useContext(StewardAuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within a <StewardProvider> with an `auth` prop.");
  }
  return ctx;
}
