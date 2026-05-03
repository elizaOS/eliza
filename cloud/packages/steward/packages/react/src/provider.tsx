import type { StewardSession } from "@stwd/sdk";
import { StewardAuth } from "@stwd/sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type {
  StewardAuthConfig,
  StewardAuthContextValue,
  StewardContextValue,
  StewardProviderProps,
  StewardProvidersState,
  StewardTenantMembership,
  TenantControlPlaneConfig,
  TenantFeatureFlags,
  TenantTheme,
} from "./types.js";
import { DEFAULT_THEME, mergeTheme } from "./utils/theme.js";

const DEFAULT_FEATURES: TenantFeatureFlags = {
  showFundingQR: true,
  showTransactionHistory: true,
  showSpendDashboard: true,
  showPolicyControls: true,
  showApprovalQueue: true,
  showSecretManager: false,
  enableSolana: true,
  showChainSelector: false,
  allowAddressExport: true,
};

// ─── Contexts ────────────────────────────────────────────────────────────────

const StewardContext = createContext<StewardContextValue | null>(null);

/**
 * Auth context — only populated when <StewardProvider auth={...}> is provided.
 * Consumers should use useAuth() hook which throws a helpful error when missing.
 */
export const StewardAuthContext = createContext<StewardAuthContextValue | null>(null);

// ─── Extended Provider Props ─────────────────────────────────────────────────

export interface StewardProviderWithAuthProps extends StewardProviderProps {
  /**
   * Optional auth configuration. When provided, StewardProvider creates a
   * StewardAuth instance and exposes auth state via useAuth().
   *
   * @example
   * <StewardProvider
   *   client={client}
   *   agentId="abc"
   *   auth={{ baseUrl: "https://api.steward.fi" }}
   *   tenantId="my-app"
   * >
   *   <App />
   * </StewardProvider>
   */
  auth?: StewardAuthConfig;
  /** Default tenant ID to authenticate against */
  tenantId?: string;
}

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * Provider that wraps all Steward components.
 * Creates internal context with client, agent ID, theme, and feature flags.
 * Optionally manages auth state when `auth` prop is provided.
 */
export function StewardProvider({
  client,
  agentId,
  features: featureOverrides,
  theme: themeOverrides,
  pollInterval = 30000,
  auth: authConfig,
  tenantId: tenantIdProp,
  children,
}: StewardProviderWithAuthProps) {
  const [tenantConfig, setTenantConfig] = useState<TenantControlPlaneConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Auth state ────────────────────────────────────────────────────────────

  const authInstance = useMemo<StewardAuth | null>(() => {
    if (!authConfig) return null;
    return new StewardAuth({
      baseUrl: authConfig.baseUrl,
      storage: authConfig.storage,
    });
  }, [authConfig?.baseUrl, authConfig?.storage, authConfig]);

  const [authSession, setAuthSession] = useState<StewardSession | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authInitialized, setAuthInitialized] = useState(false);

  // Subscribe to session changes from the StewardAuth instance
  useEffect(() => {
    if (!authInstance) return;
    // Sync initial session (must run client-side where localStorage exists)
    setAuthSession(authInstance.getSession());
    setAuthInitialized(true);
    // Subscribe to future changes
    const unsubscribe = authInstance.onSessionChange((session) => {
      setAuthSession(session);
    });
    return unsubscribe;
  }, [authInstance]);

  const signOut = useCallback(() => {
    authInstance?.signOut();
  }, [authInstance]);

  const getToken = useCallback((): string | null => {
    return authInstance?.getToken() ?? null;
  }, [authInstance]);

  const signInWithPasskey = useCallback(
    async (email: string) => {
      if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.signInWithPasskey(email);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const signInWithEmail = useCallback(
    async (email: string) => {
      if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
      return authInstance.signInWithEmail(email);
    },
    [authInstance],
  );

  const verifyEmailCallback = useCallback(
    async (token: string, email: string) => {
      if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.verifyEmailCallback(token, email);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const signInWithSIWE = useCallback(
    async (address: string, signMessage: (msg: string) => Promise<string>) => {
      if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.signInWithSIWE(address, signMessage);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  // Solana sign-in is feature-detected off the SDK instance. Older SDK builds
  // will simply expose `undefined` here and consumers must gate UI accordingly.
  const signInWithSolana = useMemo(() => {
    if (!authInstance) return undefined;
    const impl = (
      authInstance as unknown as {
        signInWithSolana?: (
          publicKey: string,
          signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
        ) => Promise<import("@stwd/sdk").StewardAuthResult>;
      }
    ).signInWithSolana;
    if (typeof impl !== "function") return undefined;
    return async (publicKey: string, signMessage: (msg: Uint8Array) => Promise<Uint8Array>) => {
      setAuthLoading(true);
      try {
        return await impl.call(authInstance, publicKey, signMessage);
      } finally {
        setAuthLoading(false);
      }
    };
  }, [authInstance]);

  const signInWithOAuth = useCallback(
    async (provider: string, config?: { redirectUri?: string; tenantId?: string }) => {
      if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.signInWithOAuth(provider, config);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  // ─── Provider discovery ─────────────────────────────────────────────────────

  const [providers, setProviders] = useState<StewardProvidersState | null>(null);
  const [isProvidersLoading, setIsProvidersLoading] = useState(false);

  useEffect(() => {
    if (!authInstance) return;
    let cancelled = false;
    setIsProvidersLoading(true);
    authInstance
      .getProviders()
      .then((result) => {
        if (!cancelled) setProviders(result);
      })
      .catch(() => {
        // Provider discovery failed — leave null, buttons won't show
      })
      .finally(() => {
        if (!cancelled) setIsProvidersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authInstance]);

  // ─── Multi-tenant state ──────────────────────────────────────────────────

  const [tenants, setTenants] = useState<StewardTenantMembership[] | null>(null);
  const [isTenantsLoading, setIsTenantsLoading] = useState(false);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(tenantIdProp ?? null);

  // Extract tenantId from session JWT claim when session changes
  useEffect(() => {
    if (authSession) {
      // Session may carry a tenantId claim; use it as active if no prop override
      if (authSession.tenantId) {
        setActiveTenantId(authSession.tenantId);
      } else if (tenantIdProp) {
        setActiveTenantId(tenantIdProp);
      }
    } else {
      // Signed out
      setActiveTenantId(tenantIdProp ?? null);
      setTenants(null);
    }
  }, [authSession, tenantIdProp]);

  const listTenants = useCallback(async (): Promise<StewardTenantMembership[]> => {
    if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
    setIsTenantsLoading(true);
    try {
      const result = await authInstance.listTenants();
      setTenants(result);
      return result;
    } finally {
      setIsTenantsLoading(false);
    }
  }, [authInstance]);

  const switchTenant = useCallback(
    async (tenantId: string): Promise<boolean> => {
      if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        const session = await authInstance.switchTenant(tenantId);
        if (session) {
          setActiveTenantId(tenantId);
          return true;
        }
        return false;
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const joinTenant = useCallback(
    async (tenantId: string): Promise<StewardTenantMembership> => {
      if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
      const membership = await authInstance.joinTenant(tenantId);
      // Refresh tenant list after joining
      try {
        await listTenants();
      } catch {
        /* best effort */
      }
      return membership;
    },
    [authInstance, listTenants],
  );

  const leaveTenant = useCallback(
    async (tenantId: string): Promise<void> => {
      if (!authInstance) throw new Error("StewardProvider: auth prop not configured");
      await authInstance.leaveTenant(tenantId);
      // Refresh tenant list after leaving
      try {
        await listTenants();
      } catch {
        /* best effort */
      }
    },
    [authInstance, listTenants],
  );

  // Auto-fetch tenants when user authenticates
  useEffect(() => {
    if (!authInstance || !authSession) return;
    let cancelled = false;
    setIsTenantsLoading(true);
    authInstance
      .listTenants()
      .then((result) => {
        if (!cancelled) setTenants(result);
      })
      .catch(() => {
        // Tenant listing failed — leave null
      })
      .finally(() => {
        if (!cancelled) setIsTenantsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authInstance, authSession]);

  const authContextValue = useMemo<StewardAuthContextValue | null>(() => {
    if (!authInstance) return null;
    return {
      isAuthenticated: authSession !== null,
      isLoading: authLoading || !authInitialized,
      user: authSession?.user ?? null,
      session: authSession,
      providers,
      isProvidersLoading,
      signOut,
      getToken,
      signInWithPasskey,
      signInWithEmail,
      verifyEmailCallback,
      signInWithSIWE,
      signInWithSolana,
      signInWithOAuth,
      // Multi-tenant
      activeTenantId,
      tenants,
      isTenantsLoading,
      listTenants,
      switchTenant,
      joinTenant,
      leaveTenant,
    };
  }, [
    authInstance,
    authSession,
    authLoading,
    authInitialized,
    providers,
    isProvidersLoading,
    signOut,
    getToken,
    signInWithPasskey,
    signInWithEmail,
    verifyEmailCallback,
    signInWithSIWE,
    signInWithSolana,
    signInWithOAuth,
    activeTenantId,
    tenants,
    isTenantsLoading,
    listTenants,
    switchTenant,
    joinTenant,
    leaveTenant,
  ]);

  // ─── Tenant config ─────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function fetchConfig() {
      try {
        const res = await fetch(`${client.getBaseUrl()}/tenants/config`, {
          headers: { Accept: "application/json" },
        });
        if (res.ok && !cancelled) {
          const json = await res.json();
          if (json.ok && json.data) {
            setTenantConfig(json.data);
          }
        }
      } catch {
        // Tenant config API not available — use defaults
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchConfig();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // ─── Theme & features ──────────────────────────────────────────────────────

  const features = useMemo<TenantFeatureFlags>(() => {
    const base = tenantConfig?.features || DEFAULT_FEATURES;
    return { ...base, ...featureOverrides };
  }, [tenantConfig, featureOverrides]);

  const theme = useMemo<TenantTheme>(() => {
    const base = tenantConfig?.theme || DEFAULT_THEME;
    return mergeTheme(base, themeOverrides);
  }, [tenantConfig, themeOverrides]);

  const value = useMemo<StewardContextValue>(
    () => ({
      client,
      agentId,
      features,
      theme,
      tenantConfig,
      isLoading,
      pollInterval,
    }),
    [client, agentId, features, theme, tenantConfig, isLoading, pollInterval],
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  const inner = <StewardContext.Provider value={value}>{children}</StewardContext.Provider>;

  if (authContextValue) {
    return (
      <StewardAuthContext.Provider value={authContextValue}>{inner}</StewardAuthContext.Provider>
    );
  }

  return inner;
}

// ─── Context hooks ────────────────────────────────────────────────────────────

/**
 * Access the Steward context. Must be used inside <StewardProvider>.
 */
export function useStewardContext(): StewardContextValue {
  const ctx = useContext(StewardContext);
  if (!ctx) {
    throw new Error("useStewardContext must be used within a <StewardProvider>");
  }
  return ctx;
}
