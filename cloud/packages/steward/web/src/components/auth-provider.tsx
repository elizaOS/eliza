"use client";

/**
 * auth-provider.tsx — Compatibility shim.
 *
 * Wraps the new @stwd/react useAuth hook to provide backward-compatible
 * properties (address, tenant, email, userId, signIn, etc.) so existing
 * dashboard pages keep working without rewrites.
 *
 * NOTE: Token syncing is handled by AuthTokenSync in providers.tsx.
 * Do NOT call setAuthToken here to avoid double re-creation of the client.
 */

import { useAuth as useNewAuth } from "@stwd/react";
import { useMemo } from "react";

interface TenantInfo {
  tenantId: string;
  tenantName: string;
  apiKey?: string;
}

export interface AuthContextType {
  address: string | undefined;
  email: string | undefined;
  userId: string | undefined;
  tenant: TenantInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signInWithPasskey: (email: string) => Promise<void>;
  signInWithEmail: (email: string) => Promise<{ ok: boolean; expiresAt?: string }>;
  completeEmailAuth: (result: { token: string; user: { id: string; email: string } }) => void;
  signOut: () => Promise<void>;
}

export function useAuth(): AuthContextType {
  const auth = useNewAuth();

  return useMemo(() => {
    const user = auth.user;

    const tenant: TenantInfo | null = auth.activeTenantId
      ? {
          tenantId: auth.activeTenantId,
          tenantName: auth.activeTenantId,
          apiKey: undefined,
        }
      : null;

    return {
      address: (user as unknown as Record<string, unknown>)?.address as string | undefined,
      email: user?.email ?? undefined,
      userId: user?.id ?? undefined,
      tenant,
      isAuthenticated: auth.isAuthenticated,
      isLoading: auth.isLoading,
      signIn: async () => {},
      signInWithPasskey: async (email: string) => {
        await auth.signInWithPasskey(email);
      },
      signInWithEmail: async (email: string) => {
        const result = await auth.signInWithEmail(email);
        return {
          ok: true,
          expiresAt: (result as unknown as Record<string, unknown>).expiresAt as string,
        };
      },
      completeEmailAuth: () => {},
      signOut: async () => {
        auth.signOut();
      },
    };
  }, [
    auth.isAuthenticated,
    auth.isLoading,
    auth.user,
    auth.activeTenantId,
    auth.signOut,
    auth.signInWithPasskey,
    auth.signInWithEmail,
  ]);
}
