/** Defines the React login context and host presentation contracts. */
import type {
  AgentBalance,
  AgentIdentity,
  ChainFamily,
  GlobalWalletApproveResult,
  GlobalWalletConsentRequest,
  LoginClient,
  LoginProviders as LoginProvidersState,
  LoginTenantMembership,
  PolicyResult,
  PolicyRule,
  PolicyType,
  TxRecord,
  TxStatus,
  UserAccountsResult,
  UserAccountUnlinkResult,
  UserLinkedAccount,
} from "@elizaos/login";

// ─── Tenant Configuration Types ───

export type PolicyExposure = "visible" | "hidden" | "enforced";

export type PolicyExposureConfig = Partial<Record<PolicyType, PolicyExposure>>;

export interface EnforcedPolicyOverride {
  type: PolicyType;
  config: Record<string, unknown>;
  allowTightening?: boolean;
}

export interface CustomizableField {
  path: string;
  label: string;
  description: string;
  type: "currency" | "number" | "toggle" | "address-list" | "chain-select";
  default: unknown;
  min?: unknown;
  max?: unknown;
}

export interface PolicyTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  policies: PolicyRule[];
  customizableFields: CustomizableField[];
}

export interface SecretRoutePreset {
  id: string;
  name: string;
  hostPattern: string;
  pathPattern: string;
  injectAs: "header" | "query" | "bearer";
  injectKey: string;
  injectFormat: string;
  provisioning: "platform" | "user";
  platformSecretId?: string;
}

export interface ApprovalNotificationChannel {
  type: "webhook" | "email" | "in-app";
  config: Record<string, string>;
}

export interface ApproverConfig {
  mode: "owner" | "tenant-admin" | "list";
  allowedApprovers?: string[];
}

export interface ApprovalConfig {
  notificationChannels: ApprovalNotificationChannel[];
  autoExpireSeconds: number;
  approvers: ApproverConfig;
  approvalWebhookUrl?: string;
  webhookCallbackEnabled: boolean;
}

export interface TenantTheme {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  mutedColor: string;
  successColor: string;
  errorColor: string;
  warningColor: string;
  borderRadius: number;
  fontFamily?: string;
  colorScheme: "light" | "dark" | "system";
  logoUrl?: string;
  faviconUrl?: string;
}

export interface TenantFeatureFlags {
  showFundingQR: boolean;
  showTransactionHistory: boolean;
  showSpendDashboard: boolean;
  showPolicyControls: boolean;
  showApprovalQueue: boolean;
  showSecretManager: boolean;
  enableSolana: boolean;
  showChainSelector: boolean;
  allowAddressExport: boolean;
}

export interface TenantControlPlaneConfig {
  tenantId: string;
  displayName: string;
  exposedPolicies: PolicyExposureConfig;
  policyTemplates: PolicyTemplate[];
  secretRoutePresets: SecretRoutePreset[];
  approvalConfig: ApprovalConfig;
  theme?: TenantTheme;
  features: TenantFeatureFlags;
}

// ─── Component Data Types ───

export interface AgentDashboardResponse {
  agent: AgentIdentity;
  balances: {
    evm?: {
      native: string;
      nativeFormatted: string;
      chainId: number;
      symbol: string;
    };
    solana?: {
      native: string;
      nativeFormatted: string;
      chainId: number;
      symbol: string;
    };
  };
  spend: {
    today: string;
    thisWeek: string;
    thisMonth: string;
    todayFormatted: string;
    thisWeekFormatted: string;
    thisMonthFormatted: string;
  };
  policies: PolicyRule[];
  pendingApprovals: number;
  recentTransactions: TxRecord[];
}

export interface PaginatedTransactionsResponse {
  transactions: TxRecord[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface SpendStats {
  range: "24h" | "7d" | "30d" | "all";
  totalSpent: string;
  totalSpentFormatted: string;
  txCount: number;
  avgTxValue: string;
  avgTxValueFormatted: string;
  largestTx: { value: string; txHash: string; timestamp: string };
  daily: Array<{
    date: string;
    spent: string;
    spentFormatted: string;
    txCount: number;
  }>;
  topDestinations: Array<{
    address: string;
    totalSent: string;
    txCount: number;
  }>;
  budgetUsage?: {
    dailyLimit: string;
    dailyUsed: string;
    dailyPercent: number;
    weeklyLimit: string;
    weeklyUsed: string;
    weeklyPercent: number;
  };
}

export interface ApprovalQueueEntry {
  id: string;
  agentId: string;
  txId: string;
  status: "pending" | "approved" | "rejected";
  to: string;
  value: string;
  chainId: number;
  policyResults: PolicyResult[];
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

// ─── Provider Types ───

export interface LoginProviderProps {
  client: LoginClient;
  agentId: string;
  features?: Partial<TenantFeatureFlags>;
  theme?: Partial<TenantTheme>;
  pollInterval?: number;
  children: React.ReactNode;
}

export interface LoginContextValue {
  client: LoginClient;
  agentId: string;
  features: TenantFeatureFlags;
  theme: TenantTheme;
  tenantConfig: TenantControlPlaneConfig | null;
  isLoading: boolean;
  pollInterval: number;
}

export interface LoginGlobalWalletConsentProps {
  /** Tenant app id in the form `tenant_id/client_id`. */
  appId: string;
  /** Exact app origin. Defaults to `window.location.origin` in browsers. */
  origin?: string;
  /** Optional redirect URI, validated against the tenant app client's allowlist. */
  redirectUri?: string;
  /** Requested global-wallet scopes. Defaults to `eth_accounts`. */
  scopes?: string[];
  /** Optional preloaded consent request for SSR or custom data loaders. */
  initialRequest?: GlobalWalletConsentRequest;
  onApproved?: (result: GlobalWalletApproveResult) => void;
  onError?: (error: Error) => void;
  className?: string;
}

// ─── Component Props ───

export interface WalletOverviewProps {
  chains?: ChainFamily[];
  showQR?: boolean;
  showCopy?: boolean;
  className?: string;
  onCopyAddress?: (address: string, chain: ChainFamily) => void;
}

export interface TransactionHistoryProps {
  pageSize?: number;
  statusFilter?: TxStatus[];
  chainFilter?: number[];
  showPolicyDetails?: boolean;
  renderTransaction?: (tx: TxRecord) => React.ReactNode;
  onTransactionClick?: (tx: TxRecord) => void;
  className?: string;
}

export interface PolicyControlsProps {
  showTemplates?: boolean;
  onSave?: (policies: PolicyRule[]) => void;
  readOnly?: boolean;
  labels?: Partial<Record<PolicyType, string>>;
  className?: string;
}

export interface ApprovalQueueProps {
  refreshInterval?: number;
  onResolve?: (txId: string, action: "approved" | "rejected") => void;
  showPolicyReason?: boolean;
  className?: string;
}

export interface SpendDashboardProps {
  range?: "24h" | "7d" | "30d" | "all";
  showBudgetUsage?: boolean;
  showChart?: boolean;
  showTopDestinations?: boolean;
  className?: string;
}

export interface LoginLinkedAccountsProps {
  showPrimaryLoginMethods?: boolean;
  showLinkedAccounts?: boolean;
  showPhoneLinking?: boolean;
  showWalletLinking?: boolean;
  showOAuthLinking?: boolean;
  showSocialLinking?: boolean;
  oauthProviders?: string[];
  oauthRedirectUri?: string;
  onOAuthLinkRequest?: (
    provider: string,
    challenge: {
      state: string;
      redirectUri: string;
      expiresIn: number;
    },
  ) => Promise<{
    code: string;
    redirectUri?: string;
    state?: string;
    codeVerifier?: string;
  } | null>;
  ethereumWallet?: {
    address: string;
    signMessage: (message: string) => Promise<string>;
  };
  solanaWallet?: {
    publicKey: string;
    /**
     * Sign the exact challenge message and return the encoded signature string
     * expected by the elizaOS API.
     */
    signMessage: (message: string) => Promise<string>;
  };
  onTelegramLinkRequest?: (
    challengeId: string,
  ) => Promise<Record<string, unknown> | null>;
  onFarcasterLinkRequest?: (nonce: string) => Promise<{
    message: string;
    signature: string;
    custodyAddress?: string;
    address?: string;
    fid?: string | number;
    username?: string;
    displayName?: string;
    pfpUrl?: string;
    pfp?: string;
  } | null>;
  allowUnlink?: boolean;
  className?: string;
  onLoaded?: (result: UserAccountsResult) => void;
  onLink?: (account: UserLinkedAccount) => void;
  onUnlink?: (
    account: UserLinkedAccount,
    result: UserAccountUnlinkResult,
  ) => void;
  onError?: (error: Error) => void;
}

// Re-export SDK types consumers will need
export type {
  AgentBalance,
  AgentIdentity,
  ChainFamily,
  LoginClient,
  PolicyResult,
  PolicyRule,
  PolicyType,
  TxRecord,
  TxStatus,
};

// ─── Multi-Tenant Types ───

export type { LoginTenantMembership } from "@elizaos/login";

// ─── Auth Types ───

export type {
  LoginGuestState,
  LoginProviders as LoginProvidersState,
  LoginSession,
  LoginUser,
  SessionStorage,
  UserAccountsResult,
  UserAccountUnlinkResult,
  UserLinkedAccount,
} from "@elizaos/login";

export interface LoginAuthConfig {
  baseUrl: string;
  storage?: import("@elizaos/login").SessionStorage;
  tenantId?: string;
  /**
   * Optional same-origin auth proxy prefix (e.g. "/api/auth") that keeps the
   * long-lived refresh token in an HttpOnly cookie instead of JS-readable
   * storage. Forwarded to the SDK — see `LoginAuthConfig.authProxyUrl`.
   */
  authProxyUrl?: string;
}

export interface LoginAuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: import("@elizaos/login").LoginUser | null;
  session: import("@elizaos/login").LoginSession | null;
  /** Available auth providers (auto-fetched on mount) */
  providers: LoginProvidersState | null;
  /** Whether providers are still loading */
  isProvidersLoading: boolean;
  /** Current guest lifecycle state, including 30-day expiry messaging. */
  guestState: import("@elizaos/login").LoginGuestState;
  signOut: () => void | Promise<void>;
  /** Create a bounded guest account session. */
  signInAsGuest: (
    options?: import("@elizaos/login").LoginGuestSignInOptions,
  ) => Promise<import("@elizaos/login").LoginAuthResult>;
  /** Upgrade the current guest with a verified email magic-link token. */
  upgradeGuestWithEmail: (
    input: import("@elizaos/login").LoginGuestUpgradeEmailInput,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /** Delete the current guest account server-side and clear local session state. */
  deleteGuest: () => Promise<import("@elizaos/login").LoginGuestDeleteResult>;
  getToken: () => string | null;
  /** Sign in with a passkey (WebAuthn). Browser-only. */
  signInWithPasskey: (
    email: string,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /**
   * Register an additional passkey for the current email on this device /
   * relying party. Use after a successful magic-link or OAuth sign-in to
   * upgrade the user to one-tap passkey login on this domain. Browser-only.
   */
  addPasskey: (
    email: string,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /** Send a magic link email. */
  signInWithEmail: (
    email: string,
    captchaToken?: string,
  ) => Promise<import("@elizaos/login").LoginEmailResult>;
  /** Send an SMS one-time passcode. */
  sendSmsOtp: (
    phone: string,
    captchaToken?: string,
  ) => Promise<import("@elizaos/login").LoginSmsOtpResult>;
  /** Verify an SMS one-time passcode. */
  verifySmsOtp: (
    phone: string,
    code: string,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /** Send a WhatsApp one-time passcode through the configured provider adapter. */
  sendWhatsAppOtp: (
    phone: string,
    captchaToken?: string,
  ) => Promise<import("@elizaos/login").LoginWhatsAppOtpResult>;
  /** Verify a WhatsApp one-time passcode. */
  verifyWhatsAppOtp: (
    phone: string,
    code: string,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /** Verify a magic link callback token. */
  verifyEmailCallback: (
    token: string,
    email: string,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /** Sign in with an Ethereum wallet via SIWE. */
  signInWithSIWE: (
    address: string,
    signMessage: (msg: string) => Promise<string>,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /**
   * Sign in with a Solana wallet via SIWS (Sign-In With Solana).
   * Optional: present only when the underlying SDK supports it. When undefined,
   * Solana wallet sign-in is disabled at runtime.
   */
  signInWithSolana?: (
    publicKey: string,
    signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /** Sign in with an OAuth provider (Google, Discord, etc.) */
  signInWithOAuth: (
    provider: string,
    config?: { redirectUri?: string; tenantId?: string },
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /** Verify a Telegram Login Widget payload and create a elizaOS session. */
  signInWithTelegram: (
    payload: import("@elizaos/login").LoginTelegramLoginPayload,
    config?: import("@elizaos/login").LoginTelegramLoginConfig,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  /** Verify a Farcaster SIWF payload and create a elizaOS session. */
  signInWithFarcaster: (
    payload: import("@elizaos/login").LoginFarcasterLoginPayload,
    config?: import("@elizaos/login").LoginFarcasterLoginConfig,
  ) => Promise<
    | import("@elizaos/login").LoginAuthResult
    | import("@elizaos/login").LoginMfaRequiredResult
  >;
  getIdentityToken: () => Promise<
    import("@elizaos/login").LoginIdentityTokenResult
  >;
  getTotpStatus: () => Promise<import("@elizaos/login").LoginTotpStatus>;
  enrollTotp: () => Promise<import("@elizaos/login").LoginTotpEnrollResult>;
  verifyTotp: (
    code: string,
  ) => Promise<import("@elizaos/login").LoginTotpVerifyResult>;
  completeTotpMfa: (
    challengeId: string,
    code: string,
  ) => Promise<import("@elizaos/login").LoginAuthResult>;
  completeRecoveryCodeMfa: (
    challengeId: string,
    recoveryCode: string,
  ) => Promise<import("@elizaos/login").LoginAuthResult>;
  stepUpWithTotp: (
    code: string,
  ) => Promise<import("@elizaos/login").LoginAuthResult>;
  stepUpWithRecoveryCode: (
    recoveryCode: string,
  ) => Promise<import("@elizaos/login").LoginAuthResult>;
  getRecoveryCodeStatus: () => Promise<
    import("@elizaos/login").LoginRecoveryCodeStatus
  >;
  regenerateRecoveryCodes: (
    code: string,
  ) => Promise<import("@elizaos/login").LoginRecoveryCodesResult>;
  unenrollTotp: (code: string) => Promise<{ ok: boolean }>;
  getSmsMfaStatus: () => Promise<import("@elizaos/login").LoginSmsMfaStatus>;
  enrollSmsMfa: (
    phone: string,
  ) => Promise<import("@elizaos/login").LoginSmsMfaEnrollResult>;
  verifySmsMfa: (
    code: string,
  ) => Promise<import("@elizaos/login").LoginSmsMfaVerifyResult>;
  sendSmsMfaCode: () => Promise<
    import("@elizaos/login").LoginSmsMfaEnrollResult
  >;
  completeSmsMfa: (
    challengeId: string,
    code: string,
  ) => Promise<import("@elizaos/login").LoginAuthResult>;
  stepUpWithSms: (
    code: string,
  ) => Promise<import("@elizaos/login").LoginAuthResult>;
  completePasskeyMfa: () => Promise<import("@elizaos/login").LoginAuthResult>;
  unenrollSmsMfa: (code: string) => Promise<{ ok: boolean }>;
  // ─── Multi-Tenant ───
  /** Currently active tenant ID from session */
  activeTenantId: string | null;
  /** Cached list of user's tenant memberships (null = not fetched yet) */
  tenants: LoginTenantMembership[] | null;
  /** Whether tenant list is currently being fetched */
  isTenantsLoading: boolean;
  /** Fetch or refresh the user's tenant memberships */
  listTenants: () => Promise<LoginTenantMembership[]>;
  /** Switch the active tenant context. Returns true on success. */
  switchTenant: (tenantId: string) => Promise<boolean>;
  /** Join a tenant (if open join mode). Returns the new membership. */
  joinTenant: (tenantId: string) => Promise<LoginTenantMembership>;
  /** Leave a tenant. Cannot leave personal tenant. */
  leaveTenant: (tenantId: string) => Promise<void>;
}

// ─── Auth Component Props ───

export interface LoginFormProps {
  onSuccess?: (
    result:
      | { token: string; user: import("@elizaos/login").LoginUser }
      | import("@elizaos/login").LoginMfaRequiredResult,
  ) => void;
  onError?: (error: Error) => void;
  showPasskey?: boolean;
  showEmail?: boolean;
  showSms?: boolean;
  showWhatsApp?: boolean;
  /**
   * Hosted/default guest lifecycle controls.
   *
   * When enabled, signed-out users can start a bounded guest session, and
   * signed-in guests see expiry, email-token upgrade, and delete controls.
   */
  showGuest?: boolean;
  guestSignInLabel?: string;
  guestUpgradeLabel?: string;
  guestDeleteLabel?: string;
  guestEmailPlaceholder?: string;
  guestTokenPlaceholder?: string;
  onGuestDeleted?: (
    result: import("@elizaos/login").LoginGuestDeleteResult,
  ) => void;
  showSIWE?: boolean;
  /**
   * First-class wallet sign-in (SIWE / SIWS).
   *
   * - `true`  - render both EVM and Solana wallet panels (subject to provider feature-detect).
   * - `false` (default) - hide both. Backwards-compatible.
   * - `{ evm: true }` - only EVM.
   * - `{ solana: true }` - only Solana.
   *
   * Backend feature flags from `GET /v1/auth/providers` (`siwe`, `siws`) act
   * as a hard gate: if the backend reports `siwe: false`, the EVM button is
   * hidden regardless of this prop.
   *
   * Requires the consumer to wrap the app in the matching wallet provider
   * (see `EVMWalletProvider` and `SolanaWalletProvider` from `@elizaos/ui`).
   */
  showWallets?: boolean | { evm?: boolean; solana?: boolean };
  showGoogle?: boolean;
  showDiscord?: boolean;
  showGithub?: boolean;
  showTwitter?: boolean;
  /**
   * Show Telegram login when the API reports Telegram is enabled.
   * Provide `getTelegramLoginPayload` from Telegram's official login widget
   * callback; the component exchanges that signed payload with elizaOS.
   */
  showTelegram?: boolean;
  getTelegramLoginPayload?: () =>
    | import("@elizaos/login").LoginTelegramLoginPayload
    | Promise<import("@elizaos/login").LoginTelegramLoginPayload>;
  /**
   * Show Farcaster login when the API reports Farcaster is enabled.
   * Provide `getFarcasterLoginPayload` from a SIWF-capable client flow.
   */
  showFarcaster?: boolean;
  getFarcasterLoginPayload?: () =>
    | import("@elizaos/login").LoginFarcasterLoginPayload
    | Promise<import("@elizaos/login").LoginFarcasterLoginPayload>;
  /** "card" adds bg/border/padding wrapper; "inline" renders with no container styling */
  variant?: "card" | "inline";
  /** Custom logo element rendered at top of the login widget */
  logo?: React.ReactNode;
  /** Title text (e.g. "sign in", "welcome back"). */
  title?: string;
  /** Subtitle text below the title */
  subtitle?: string;
  /** Called when an OAuth provider button is clicked (for custom handling) */
  onProviderClick?: (provider: string) => void;
  /** Tenant ID to authenticate against (passed through to sign-in methods) */
  tenantId?: string;
  className?: string;
}

export interface LoginAuthGuardProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  loadingFallback?: React.ReactNode;
}

export interface LoginUserButtonProps {
  className?: string;
  onSignOut?: () => void;
  showWallet?: boolean;
  avatarSize?: number;
  /** Show an inline tenant switcher in the dropdown (default: false) */
  showTenantSwitcher?: boolean;
}

export interface LoginEmailCallbackProps {
  onSuccess?: (
    result:
      | { token: string; user: import("@elizaos/login").LoginUser }
      | import("@elizaos/login").LoginMfaRequiredResult,
  ) => void;
  onError?: (error: Error) => void;
  redirectTo?: string;
}

export interface LoginOAuthCallbackProps {
  onSuccess?: (
    result:
      | { token: string; user: import("@elizaos/login").LoginUser }
      | { code: string; state: string },
  ) => void;
  onError?: (error: Error) => void;
  redirectTo?: string;
  provider?: string;
}

export interface LoginMfaChallengeProps {
  challenge: import("@elizaos/login").LoginMfaRequiredResult["mfa"];
  onSuccess?: (result: import("@elizaos/login").LoginAuthResult) => void;
  onError?: (error: Error) => void;
  allowRecoveryCode?: boolean;
  className?: string;
}

export interface LoginMfaSettingsProps {
  onRecoveryCodes?: (codes: string[]) => void;
  onError?: (error: Error) => void;
  className?: string;
}

// ─── Tenant Picker Props ───

export interface LoginTenantPickerProps {
  /** Callback after a tenant switch completes */
  onSwitch?: (tenantId: string) => void;
  /** Display variant: "dropdown" (compact, click to expand) or "list" (always visible) */
  variant?: "dropdown" | "list";
  className?: string;
}
