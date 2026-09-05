/** Maintains the shared login client, account session and authentication operations for React consumers. */
import type { LoginSession } from "@elizaos/login";
import { LoginAuth } from "@elizaos/login";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  LoginAuthConfig,
  LoginAuthContextValue,
  LoginContextValue,
  LoginProviderProps,
  LoginProvidersState,
  LoginTenantMembership,
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

const LoginContext = createContext<LoginContextValue | null>(null);

/**
 * Auth context — only populated when <LoginProvider auth={...}> is provided.
 * Consumers should use useAuth() hook which throws a helpful error when missing.
 */
export const LoginAuthContext = createContext<LoginAuthContextValue | null>(
  null,
);

// ─── Extended Provider Props ─────────────────────────────────────────────────

export interface LoginProviderWithAuthProps extends LoginProviderProps {
  /**
   * Optional auth configuration. When provided, LoginProvider creates a
   * LoginAuth instance and exposes auth state via useAuth().
   *
   * @example
   * <LoginProvider
   *   client={client}
   *   agentId="abc"
   *   auth={{ baseUrl: "http://localhost:3200" }}
   *   tenantId="my-app"
   * >
   *   <App />
   * </LoginProvider>
   */
  auth?: LoginAuthConfig;
  /** Default tenant ID to authenticate against */
  tenantId?: string;
}

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * Provider that wraps all elizaOS components.
 * Creates internal context with client, agent ID, theme, and feature flags.
 * Optionally manages auth state when `auth` prop is provided.
 */
export function LoginProvider({
  client,
  agentId,
  features: featureOverrides,
  theme: themeOverrides,
  pollInterval = 30000,
  auth: authConfig,
  tenantId: tenantIdProp,
  children,
}: LoginProviderWithAuthProps) {
  const [tenantConfig, setTenantConfig] =
    useState<TenantControlPlaneConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // ─── Auth state ────────────────────────────────────────────────────────────

  const authBaseUrl = authConfig?.baseUrl;
  const authStorage = authConfig?.storage;
  const authTenantId = authConfig?.tenantId ?? tenantIdProp;
  const authProxyUrl = authConfig?.authProxyUrl;
  const authInstance = useMemo<LoginAuth | null>(() => {
    if (authBaseUrl === undefined) return null;
    return new LoginAuth({
      baseUrl: authBaseUrl,
      storage: authStorage,
      tenantId: authTenantId,
      authProxyUrl,
    });
  }, [authBaseUrl, authStorage, authTenantId, authProxyUrl]);

  const [authSession, setAuthSession] = useState<LoginSession | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authInitialized, setAuthInitialized] = useState(false);
  const lastBootstrapKeyRef = useRef<string | null>(null);

  // Subscribe to session changes from the LoginAuth instance
  useEffect(() => {
    if (!authInstance) return;
    // Sync initial session from the configured SDK storage.
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

  const guestState = authInstance?.getGuestState() ?? {
    isGuest: false,
    isExpired: false,
    expiryMessage: null,
  };

  const signInAsGuest = useCallback(
    async (options?: import("@elizaos/login").LoginGuestSignInOptions) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.signInAsGuest(options);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const upgradeGuestWithEmail = useCallback(
    async (input: import("@elizaos/login").LoginGuestUpgradeEmailInput) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.upgradeGuestWithEmail(input);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const deleteGuest = useCallback(async () => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
    setAuthLoading(true);
    try {
      return await authInstance.deleteGuest();
    } finally {
      setAuthLoading(false);
    }
  }, [authInstance]);

  const getToken = useCallback((): string | null => {
    return authInstance?.getToken() ?? null;
  }, [authInstance]);

  const signInWithPasskey = useCallback(
    async (email: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.signInWithPasskey(email);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const addPasskey = useCallback(
    async (email: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.addPasskey(email);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const signInWithEmail = useCallback(
    async (email: string, captchaToken?: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.signInWithEmail(email, captchaToken);
    },
    [authInstance],
  );

  const sendSmsOtp = useCallback(
    async (phone: string, captchaToken?: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.sendSmsOtp(phone, captchaToken);
    },
    [authInstance],
  );

  const verifySmsOtp = useCallback(
    async (phone: string, code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.verifySmsOtp(phone, code);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const sendWhatsAppOtp = useCallback(
    async (phone: string, captchaToken?: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.sendWhatsAppOtp(phone, captchaToken);
    },
    [authInstance],
  );

  const verifyWhatsAppOtp = useCallback(
    async (phone: string, code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.verifyWhatsAppOtp(phone, code);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const verifyEmailCallback = useCallback(
    async (token: string, email: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
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
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
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
        ) => Promise<
          | import("@elizaos/login").LoginAuthResult
          | import("@elizaos/login").LoginMfaRequiredResult
        >;
      }
    ).signInWithSolana;
    if (typeof impl !== "function") return undefined;
    return async (
      publicKey: string,
      signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
    ) => {
      setAuthLoading(true);
      try {
        return await impl.call(authInstance, publicKey, signMessage);
      } finally {
        setAuthLoading(false);
      }
    };
  }, [authInstance]);

  const signInWithOAuth = useCallback(
    async (
      provider: string,
      config?: { redirectUri?: string; tenantId?: string },
    ) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.signInWithOAuth(provider, config);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const signInWithTelegram = useCallback(
    async (
      payload: import("@elizaos/login").LoginTelegramLoginPayload,
      config?: import("@elizaos/login").LoginTelegramLoginConfig,
    ) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.signInWithTelegram(payload, config);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const signInWithFarcaster = useCallback(
    async (
      payload: import("@elizaos/login").LoginFarcasterLoginPayload,
      config?: import("@elizaos/login").LoginFarcasterLoginConfig,
    ) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.signInWithFarcaster(payload, config);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const getIdentityToken = useCallback(async () => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
    return authInstance.getIdentityToken();
  }, [authInstance]);

  const getTotpStatus = useCallback(async () => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
    return authInstance.getTotpStatus();
  }, [authInstance]);

  const enrollTotp = useCallback(async () => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
    return authInstance.enrollTotp();
  }, [authInstance]);

  const verifyTotp = useCallback(
    async (code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.verifyTotp(code);
    },
    [authInstance],
  );

  const completeTotpMfa = useCallback(
    async (challengeId: string, code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.completeTotpMfa(challengeId, code);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const completeRecoveryCodeMfa = useCallback(
    async (challengeId: string, recoveryCode: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.completeRecoveryCodeMfa(
          challengeId,
          recoveryCode,
        );
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const stepUpWithTotp = useCallback(
    async (code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.stepUpWithTotp(code);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const stepUpWithRecoveryCode = useCallback(
    async (recoveryCode: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.stepUpWithRecoveryCode(recoveryCode);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const getRecoveryCodeStatus = useCallback(async () => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
    return authInstance.getRecoveryCodeStatus();
  }, [authInstance]);

  const regenerateRecoveryCodes = useCallback(
    async (code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.regenerateRecoveryCodes(code);
    },
    [authInstance],
  );

  const unenrollTotp = useCallback(
    async (code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.unenrollTotp(code);
    },
    [authInstance],
  );

  const getSmsMfaStatus = useCallback(async () => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
    return authInstance.getSmsMfaStatus();
  }, [authInstance]);

  const enrollSmsMfa = useCallback(
    async (phone: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.enrollSmsMfa(phone);
    },
    [authInstance],
  );

  const verifySmsMfa = useCallback(
    async (code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.verifySmsMfa(code);
    },
    [authInstance],
  );

  const sendSmsMfaCode = useCallback(async () => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
    return authInstance.sendSmsMfaCode();
  }, [authInstance]);

  const completeSmsMfa = useCallback(
    async (challengeId: string, code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.completeSmsMfa(challengeId, code);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const stepUpWithSms = useCallback(
    async (code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      setAuthLoading(true);
      try {
        return await authInstance.stepUpWithSms(code);
      } finally {
        setAuthLoading(false);
      }
    },
    [authInstance],
  );

  const completePasskeyMfa = useCallback(async () => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
    setAuthLoading(true);
    try {
      return await authInstance.completePasskeyMfa();
    } finally {
      setAuthLoading(false);
    }
  }, [authInstance]);

  const unenrollSmsMfa = useCallback(
    async (code: string) => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
      return authInstance.unenrollSmsMfa(code);
    },
    [authInstance],
  );

  // ─── Provider discovery ─────────────────────────────────────────────────────

  const [providers, setProviders] = useState<LoginProvidersState | null>(null);
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

  const [tenants, setTenants] = useState<LoginTenantMembership[] | null>(null);
  const [isTenantsLoading, setIsTenantsLoading] = useState(false);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(
    tenantIdProp ?? null,
  );

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

  const listTenants = useCallback(async (): Promise<
    LoginTenantMembership[]
  > => {
    if (!authInstance)
      throw new Error("LoginProvider: auth prop not configured");
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
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
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
    async (tenantId: string): Promise<LoginTenantMembership> => {
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
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
      if (!authInstance)
        throw new Error("LoginProvider: auth prop not configured");
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

  useEffect(() => {
    if (!authInstance || !authSession) return;
    const tenantId = authInstance.getTenantId() ?? activeTenantId ?? undefined;
    const bootstrapKey = `${authSession.token}:${tenantId ?? ""}`;
    if (lastBootstrapKeyRef.current === bootstrapKey) return;
    lastBootstrapKeyRef.current = bootstrapKey;
    authInstance.getCurrentUser({ tenantId }).catch(() => {
      // Bootstrap is best effort: auth remains valid even if user metadata or
      // create-on-login wallet provisioning is temporarily unavailable.
    });
  }, [activeTenantId, authInstance, authSession]);

  const authContextValue = useMemo<LoginAuthContextValue | null>(() => {
    if (!authInstance) return null;
    return {
      isAuthenticated: authSession !== null,
      isLoading: authLoading || !authInitialized,
      user: authSession?.user ?? null,
      session: authSession,
      providers,
      isProvidersLoading,
      guestState,
      signOut,
      signInAsGuest,
      upgradeGuestWithEmail,
      deleteGuest,
      getToken,
      signInWithPasskey,
      addPasskey,
      signInWithEmail,
      sendSmsOtp,
      verifySmsOtp,
      sendWhatsAppOtp,
      verifyWhatsAppOtp,
      verifyEmailCallback,
      signInWithSIWE,
      signInWithSolana,
      signInWithOAuth,
      signInWithTelegram,
      signInWithFarcaster,
      getIdentityToken,
      getTotpStatus,
      enrollTotp,
      verifyTotp,
      completeTotpMfa,
      completeRecoveryCodeMfa,
      stepUpWithTotp,
      stepUpWithRecoveryCode,
      getRecoveryCodeStatus,
      regenerateRecoveryCodes,
      unenrollTotp,
      getSmsMfaStatus,
      enrollSmsMfa,
      verifySmsMfa,
      sendSmsMfaCode,
      completeSmsMfa,
      stepUpWithSms,
      completePasskeyMfa,
      unenrollSmsMfa,
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
    guestState,
    signOut,
    signInAsGuest,
    upgradeGuestWithEmail,
    deleteGuest,
    getToken,
    signInWithPasskey,
    addPasskey,
    signInWithEmail,
    sendSmsOtp,
    verifySmsOtp,
    sendWhatsAppOtp,
    verifyWhatsAppOtp,
    verifyEmailCallback,
    signInWithSIWE,
    signInWithSolana,
    signInWithOAuth,
    signInWithTelegram,
    signInWithFarcaster,
    getIdentityToken,
    getTotpStatus,
    enrollTotp,
    verifyTotp,
    completeTotpMfa,
    completeRecoveryCodeMfa,
    stepUpWithTotp,
    stepUpWithRecoveryCode,
    getRecoveryCodeStatus,
    regenerateRecoveryCodes,
    unenrollTotp,
    getSmsMfaStatus,
    enrollSmsMfa,
    verifySmsMfa,
    sendSmsMfaCode,
    completeSmsMfa,
    stepUpWithSms,
    completePasskeyMfa,
    unenrollSmsMfa,
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

  const value = useMemo<LoginContextValue>(
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

  const inner = (
    <LoginContext.Provider value={value}>{children}</LoginContext.Provider>
  );

  if (authContextValue) {
    return (
      <LoginAuthContext.Provider value={authContextValue}>
        {inner}
      </LoginAuthContext.Provider>
    );
  }

  return inner;
}

// ─── Context hooks ────────────────────────────────────────────────────────────

/**
 * Access the elizaOS context. Must be used inside <LoginProvider>.
 */
export function useLoginContext(): LoginContextValue {
  const ctx = useContext(LoginContext);
  if (!ctx) {
    throw new Error("useLoginContext must be used within a <LoginProvider>");
  }
  return ctx;
}
