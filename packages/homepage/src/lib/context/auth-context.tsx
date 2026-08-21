/**
 * Homepage authentication context for Cloud-backed login, session persistence,
 * and linked account state.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { elizacloudFetch, getAuthToken } from "@/lib/api/client";
import { signInWithSolana as siwsSignIn } from "@/lib/api/siws";
import { confirmSiwsSession } from "@/lib/context/siws-session";

export interface TelegramAuthData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface ElizaAppUser {
  id: string;
  telegram_id: string | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  discord_id: string | null;
  discord_username: string | null;
  discord_global_name: string | null;
  discord_avatar_url: string | null;
  whatsapp_id: string | null;
  whatsapp_name: string | null;
  phone_number: string | null;
  name: string | null;
  avatar: string | null;
  organization_id: string | null;
  created_at: string;
}

export interface ElizaAppOrganization {
  id: string;
  name: string;
  credit_balance: string;
}

interface AuthResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

export type TelegramLoginResult = AuthResult & {
  continuationRedeemed?: boolean;
};
export type DiscordLoginResult = AuthResult;
export type WhatsAppLoginResult = AuthResult;
export type SolanaLoginResult = AuthResult & { address?: string };
export type LinkPhoneResult = AuthResult;

interface AuthContextValue {
  user: ElizaAppUser | null;
  organization: ElizaAppOrganization | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;
  loginWithTelegram: (
    data: TelegramAuthData,
    phoneNumber: string,
    existingToken?: string,
    onboardingSession?: string | null,
  ) => Promise<TelegramLoginResult>;
  loginWithDiscord: (
    code: string,
    redirectUri: string,
    state: string,
    phoneNumber?: string,
    existingToken?: string,
  ) => Promise<DiscordLoginResult>;
  loginWithWhatsApp: (
    whatsappId: string,
    existingToken?: string,
  ) => Promise<WhatsAppLoginResult>;
  loginWithSolana: () => Promise<SolanaLoginResult>;
  linkPhone: (phoneNumber: string) => Promise<LinkPhoneResult>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_STORAGE_KEY = "eliza_app_session";

interface TelegramAuthResponse {
  success: boolean;
  user: {
    id: string;
    telegram_id: string;
    telegram_username: string | null;
    phone_number: string;
    name: string | null;
    organization_id: string;
  };
  session: {
    token: string;
    expires_at: string;
  };
  is_new_user: boolean;
  continuation_redeemed?: boolean;
  error?: string;
  code?: string;
}

interface DiscordAuthResponse {
  success: boolean;
  user: {
    id: string;
    discord_id: string;
    discord_username: string | null;
    discord_global_name: string | null;
    phone_number: string | null;
    name: string | null;
    organization_id: string;
  };
  session: {
    token: string;
    expires_at: string;
  };
  is_new_user: boolean;
  error?: string;
  code?: string;
}

interface WhatsAppAuthResponse {
  success: boolean;
  user: {
    id: string;
    whatsapp_id: string;
    whatsapp_name: string | null;
    phone_number: string | null;
    name: string | null;
    organization_id: string;
  };
  session: {
    token: string;
    expires_at: string;
  };
  error?: string;
  code?: string;
}

interface UserInfoResponse {
  user: ElizaAppUser;
  organization: ElizaAppOrganization | null;
}

function parseAuthError(err: unknown): AuthResult {
  const rawMessage =
    err instanceof Error ? err.message : "Authentication failed";
  const jsonStart = rawMessage.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(rawMessage.slice(jsonStart));
      return {
        success: false,
        error: parsed.error || "Authentication failed",
        errorCode: parsed.code,
      };
    } catch {
      return { success: false, error: rawMessage };
    }
  }
  return { success: false, error: rawMessage };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ElizaAppUser | null>(null);
  const [organization, setOrganization] = useState<ElizaAppOrganization | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setSessionToken = useCallback((token: string | null) => {
    if (typeof window === "undefined") return;
    if (token) {
      localStorage.setItem(SESSION_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  const loadUserInfo = useCallback(
    async (token: string): Promise<UserInfoResponse> =>
      elizacloudFetch<UserInfoResponse>("/api/eliza-app/user/me", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
    [],
  );

  const applyUserInfo = useCallback((data: UserInfoResponse): void => {
    setUser(data.user);
    setOrganization(data.organization);
  }, []);

  const fetchUserInfo = useCallback(
    async (tokenOverride?: string): Promise<boolean> => {
      const token = tokenOverride || getAuthToken();
      if (!token) {
        return false;
      }

      const data = await loadUserInfo(token);
      applyUserInfo(data);
      return true;
    },
    [applyUserInfo, loadUserInfo],
  );

  useEffect(() => {
    async function initAuth() {
      setIsLoading(true);
      setError(null);

      const token = getAuthToken();
      if (!token) {
        setIsLoading(false);
        return;
      }

      try {
        await fetchUserInfo();
      } catch (err) {
        console.error("[Auth] Failed to fetch user info:", err);
        setSessionToken(null);
        setUser(null);
        setOrganization(null);
      } finally {
        setIsLoading(false);
      }
    }

    initAuth();
  }, [setSessionToken, fetchUserInfo]);

  const loginWithTelegram = useCallback(
    async (
      data: TelegramAuthData,
      phoneNumber: string,
      existingToken?: string,
      onboardingSession?: string | null,
    ): Promise<TelegramLoginResult> => {
      setIsLoading(true);
      setError(null);

      try {
        const headers: Record<string, string> = {};
        if (existingToken) {
          headers.Authorization = `Bearer ${existingToken}`;
        }

        const response = await elizacloudFetch<TelegramAuthResponse>(
          "/api/eliza-app/auth/telegram",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...data,
              phone_number: phoneNumber,
              ...(onboardingSession && {
                onboarding_session: onboardingSession,
              }),
            }),
          },
        );

        if (!response.success) {
          const errorMessage = response.error || "Authentication failed";
          setError(errorMessage);
          return {
            success: false,
            error: errorMessage,
            errorCode: response.code,
          };
        }

        const token = response.session.token;
        setSessionToken(token);
        await fetchUserInfo(token);
        return {
          success: true,
          continuationRedeemed: response.continuation_redeemed === true,
        };
      } catch (err) {
        const result = parseAuthError(err);
        setError(result.error ?? "Authentication failed");
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [setSessionToken, fetchUserInfo],
  );

  const loginWithDiscord = useCallback(
    async (
      code: string,
      redirectUri: string,
      state: string,
      phoneNumber?: string,
      existingToken?: string,
    ): Promise<DiscordLoginResult> => {
      setIsLoading(true);
      setError(null);

      try {
        const headers: Record<string, string> = {};
        if (existingToken) {
          headers.Authorization = `Bearer ${existingToken}`;
        }

        const response = await elizacloudFetch<DiscordAuthResponse>(
          "/api/eliza-app/auth/discord",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              code,
              redirect_uri: redirectUri,
              state,
              ...(phoneNumber && { phone_number: phoneNumber }),
            }),
          },
        );

        if (!response.success) {
          const errorMessage = response.error || "Authentication failed";
          setError(errorMessage);
          return {
            success: false,
            error: errorMessage,
            errorCode: response.code,
          };
        }

        const token = response.session.token;
        setSessionToken(token);
        await fetchUserInfo(token);
        return { success: true };
      } catch (err) {
        const result = parseAuthError(err);
        setError(result.error ?? "Authentication failed");
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [setSessionToken, fetchUserInfo],
  );

  const loginWithWhatsApp = useCallback(
    async (
      whatsappId: string,
      existingToken?: string,
    ): Promise<WhatsAppLoginResult> => {
      setIsLoading(true);
      setError(null);

      try {
        const headers: Record<string, string> = {};
        if (existingToken) {
          headers.Authorization = `Bearer ${existingToken}`;
        }

        const response = await elizacloudFetch<WhatsAppAuthResponse>(
          "/api/eliza-app/auth/whatsapp",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ whatsapp_id: whatsappId }),
          },
        );

        if (!response.success) {
          const errorMessage = response.error || "Authentication failed";
          setError(errorMessage);
          return {
            success: false,
            error: errorMessage,
            errorCode: response.code,
          };
        }

        const token = response.session.token;
        setSessionToken(token);
        await fetchUserInfo(token);
        return { success: true };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Authentication failed";
        setError(message);
        return { success: false, error: message };
      } finally {
        setIsLoading(false);
      }
    },
    [setSessionToken, fetchUserInfo],
  );

  const linkPhone = useCallback(
    async (phoneNumber: string): Promise<LinkPhoneResult> => {
      const token = getAuthToken();
      if (!token) {
        return {
          success: false,
          error: "Not authenticated",
          errorCode: "UNAUTHORIZED",
        };
      }

      try {
        const response = await elizacloudFetch<{
          success: boolean;
          phone_number?: string;
          error?: string;
          code?: string;
        }>("/api/eliza-app/user/phone", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ phone_number: phoneNumber }),
        });

        if (!response.success) {
          return {
            success: false,
            error: response.error || "Failed to link phone number",
            errorCode: response.code,
          };
        }

        await fetchUserInfo(token);
        return { success: true };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to link phone number";
        return { success: false, error: message };
      }
    },
    [fetchUserInfo],
  );

  const loginWithSolana = useCallback(async (): Promise<SolanaLoginResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await siwsSignIn();
      await confirmSiwsSession(result.apiKey, {
        loadCanonicalUser: loadUserInfo,
        commitSession: (token, identity) => {
          setSessionToken(token);
          applyUserInfo(identity);
        },
      });
      return { success: true, address: result.address };
    } catch (err) {
      const result = parseAuthError(err);
      setError(result.error ?? "Solana sign-in failed");
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [applyUserInfo, loadUserInfo, setSessionToken]);

  const logout = useCallback(() => {
    setSessionToken(null);
    setUser(null);
    setOrganization(null);
    setError(null);
  }, [setSessionToken]);

  const refreshUser = useCallback(async () => {
    try {
      await fetchUserInfo();
    } catch (err) {
      console.error("[Auth] Failed to refresh user:", err);
    }
  }, [fetchUserInfo]);

  const value: AuthContextValue = {
    user,
    organization,
    isLoading,
    isAuthenticated: !!user,
    error,
    loginWithTelegram,
    loginWithDiscord,
    loginWithWhatsApp,
    loginWithSolana,
    linkPhone,
    logout,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export { getAuthToken };
