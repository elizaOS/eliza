import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { elizacloudFetch, getAuthToken } from "@/lib/api/client";

/**
 * Telegram auth data from Login Widget
 */
export interface TelegramAuthData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/**
 * User data from API
 */
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

/**
 * Organization data
 */
export interface ElizaAppOrganization {
  id: string;
  name: string;
  credit_balance: string;
}

/**
 * Result of Telegram login with phone
 */
export interface TelegramLoginResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Result of Discord login
 */
export interface DiscordLoginResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Result of WhatsApp login
 */
export interface WhatsAppLoginResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Result of linking a phone number
 */
export interface LinkPhoneResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Auth context value
 */
interface AuthContextValue {
  user: ElizaAppUser | null;
  organization: ElizaAppOrganization | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;
  /**
   * Login with Telegram OAuth data + phone number.
   * Phone is required to prevent bot abuse and enable cross-platform (iMessage) linking.
   * If existingToken is provided, links Telegram to the existing account (session-based linking).
   */
  loginWithTelegram: (
    data: TelegramAuthData,
    phoneNumber: string,
    existingToken?: string,
  ) => Promise<TelegramLoginResult>;
  /**
   * Login with Discord OAuth2 code.
   * State is required for CSRF protection.
   * Phone is optional - enables cross-platform (iMessage) linking if provided.
   * If existingToken is provided, links Discord to the existing account (session-based linking).
   */
  loginWithDiscord: (
    code: string,
    redirectUri: string,
    state: string,
    phoneNumber?: string,
    existingToken?: string,
  ) => Promise<DiscordLoginResult>;
  /**
   * Login with WhatsApp ID.
   * User must first message the WhatsApp bot to be auto-provisioned.
   * If existingToken is provided, links WhatsApp to the existing account.
   */
  loginWithWhatsApp: (
    whatsappId: string,
    existingToken?: string,
  ) => Promise<WhatsAppLoginResult>;
  /**
   * Link a phone number to the current user's account.
   * Enables cross-platform messaging with iMessage.
   */
  linkPhone: (phoneNumber: string) => Promise<LinkPhoneResult>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_STORAGE_KEY = "eliza_app_session";

/**
 * Telegram auth response from API
 */
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
  error?: string;
  code?: string;
}

/**
 * Discord auth response from API
 */
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

/**
 * WhatsApp auth response from API
 */
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

/**
 * User info response from API
 */
interface UserInfoResponse {
  user: ElizaAppUser;
  organization: ElizaAppOrganization | null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ElizaAppUser | null>(null);
  const [organization, setOrganization] = useState<ElizaAppOrganization | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Get stored session token
   */
  const getSessionToken = useCallback((): string | null => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(SESSION_STORAGE_KEY);
  }, []);

  /**
   * Store session token
   */
  const setSessionToken = useCallback((token: string | null) => {
    if (typeof window === "undefined") return;
    if (token) {
      localStorage.setItem(SESSION_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  /**
   * Fetch current user info
   * @param tokenOverride - Optional token to use instead of reading from storage
   */
  const fetchUserInfo = useCallback(
    async (tokenOverride?: string): Promise<boolean> => {
      const token = tokenOverride || getSessionToken();
      if (!token) {
        return false;
      }

      const data = await elizacloudFetch<UserInfoResponse>(
        "/api/eliza-app/user/me",
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      setUser(data.user);
      setOrganization(data.organization);
      return true;
    },
    [getSessionToken],
  );

  /**
   * Initialize auth state on mount
   */
  useEffect(() => {
    async function initAuth() {
      setIsLoading(true);
      setError(null);

      const token = getSessionToken();
      if (!token) {
        setIsLoading(false);
        return;
      }

      try {
        await fetchUserInfo();
      } catch (err) {
        // Token might be expired or invalid
        console.error("[Auth] Failed to fetch user info:", err);
        setSessionToken(null);
        setUser(null);
        setOrganization(null);
      } finally {
        setIsLoading(false);
      }
    }

    initAuth();
  }, [getSessionToken, setSessionToken, fetchUserInfo]);

  /**
   * Login with Telegram OAuth data + phone number.
   *
   * The phone number is required for two reasons:
   * 1. Prevents Telegram bot abuse (adds friction for automated signups)
   * 2. Enables cross-platform linking with iMessage (same phone = same account)
   *
   * If the phone is already associated with an iMessage-only user,
   * this will link the Telegram account to that existing user.
   */
  const loginWithTelegram = useCallback(
    async (
      data: TelegramAuthData,
      phoneNumber: string,
      existingToken?: string,
    ): Promise<TelegramLoginResult> => {
      setIsLoading(true);
      setError(null);

      try {
        const headers: Record<string, string> = {};
        // If an existing token is provided, send it for session-based linking
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
        // Try to parse structured error from API response (elizacloudFetch throws with the response text)
        const rawMessage =
          err instanceof Error ? err.message : "Authentication failed";
        let errorMessage = "Authentication failed";
        let errorCode: string | undefined;
        try {
          const jsonStart = rawMessage.indexOf("{");
          if (jsonStart >= 0) {
            const parsed = JSON.parse(rawMessage.slice(jsonStart));
            errorMessage = parsed.error || errorMessage;
            errorCode = parsed.code;
          }
        } catch {
          errorMessage = rawMessage;
        }
        setError(errorMessage);
        return { success: false, error: errorMessage, errorCode };
      } finally {
        setIsLoading(false);
      }
    },
    [setSessionToken, fetchUserInfo],
  );

  /**
   * Login with Discord OAuth2 code.
   * State is required for CSRF protection.
   * Phone number is optional - enables cross-platform linking if provided.
   */
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
        // If an existing token is provided, send it for session-based linking
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
        // Try to parse structured error from API response (elizacloudFetch throws with the response text)
        const rawMessage =
          err instanceof Error ? err.message : "Authentication failed";
        let errorMessage = "Authentication failed";
        let errorCode: string | undefined;
        try {
          // elizacloudFetch throws: "elizacloud API error <status>: <json-body>"
          const jsonStart = rawMessage.indexOf("{");
          if (jsonStart >= 0) {
            const parsed = JSON.parse(rawMessage.slice(jsonStart));
            errorMessage = parsed.error || errorMessage;
            errorCode = parsed.code;
          }
        } catch {
          errorMessage = rawMessage;
        }
        setError(errorMessage);
        return { success: false, error: errorMessage, errorCode };
      } finally {
        setIsLoading(false);
      }
    },
    [setSessionToken, fetchUserInfo],
  );

  /**
   * Login with WhatsApp ID.
   * User must first message the WhatsApp bot to get auto-provisioned.
   */
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

  /**
   * Link a phone number to the current user's account.
   * Used when a Discord user who skipped phone wants to add it later.
   */
  const linkPhone = useCallback(
    async (phoneNumber: string): Promise<LinkPhoneResult> => {
      const token = getSessionToken();
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

        // Refresh user data to pick up the new phone number
        await fetchUserInfo(token);
        return { success: true };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to link phone number";
        return { success: false, error: message };
      }
    },
    [getSessionToken, fetchUserInfo],
  );

  /**
   * Logout
   */
  const logout = useCallback(() => {
    setSessionToken(null);
    setUser(null);
    setOrganization(null);
    setError(null);
  }, [setSessionToken]);

  /**
   * Refresh user info
   */
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
    linkPhone,
    logout,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth context
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

// Re-export getAuthToken from client for backwards compatibility
export { getAuthToken };
