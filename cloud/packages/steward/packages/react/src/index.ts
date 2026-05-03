// ─── Provider ───

export { ApprovalQueue } from "./components/ApprovalQueue.js";
export { PolicyControls } from "./components/PolicyControls.js";
export { SpendDashboard } from "./components/SpendDashboard.js";
export { StewardAuthGuard } from "./components/StewardAuthGuard.js";
export { StewardEmailCallback } from "./components/StewardEmailCallback.js";
// ─── Components ───
export { StewardLogin } from "./components/StewardLogin.js";
export { StewardOAuthCallback } from "./components/StewardOAuthCallback.js";
export { StewardTenantPicker } from "./components/StewardTenantPicker.js";
export { StewardUserButton } from "./components/StewardUserButton.js";
export { TransactionHistory } from "./components/TransactionHistory.js";
export { WalletOverview } from "./components/WalletOverview.js";
// <WalletLogin /> and EVM/Solana provider wrappers live at the
// `@stwd/react/wallet` subpath to keep their optional peer-dep imports
// (wagmi, @rainbow-me/rainbowkit, @solana/*) off the root entry point.
// Importing `@stwd/react` alone will NOT resolve those modules.
export { useApprovals } from "./hooks/useApprovals.js";
// ─── Hooks ───
export { useAuth } from "./hooks/useAuth.js";
export { usePolicies } from "./hooks/usePolicies.js";
export { useSpend } from "./hooks/useSpend.js";
export { useSteward } from "./hooks/useSteward.js";
export { useTransactions } from "./hooks/useTransactions.js";
export { useWallet } from "./hooks/useWallet.js";
// ─── Icons ───
export {
  DiscordIcon,
  EmailIcon,
  EthereumIcon,
  GoogleIcon,
  PasskeyIcon,
} from "./icons/index.js";
export { StewardProvider } from "./provider.js";
// ─── Types ───
export type {
  AgentBalance,
  // Component data
  AgentDashboardResponse,
  AgentIdentity,
  ApprovalConfig,
  ApprovalQueueEntry,
  ApprovalQueueProps,
  ApproverConfig,
  ChainFamily,
  CustomizableField,
  EnforcedPolicyOverride,
  PaginatedTransactionsResponse,
  PolicyControlsProps,
  PolicyExposure,
  PolicyExposureConfig,
  PolicyResult,
  PolicyRule,
  PolicyTemplate,
  PolicyType,
  SecretRoutePreset,
  SpendDashboardProps,
  SpendStats,
  StewardAuthGuardProps,
  // Re-exported SDK types
  StewardClient,
  StewardContextValue,
  StewardEmailCallbackProps,
  StewardLoginProps,
  StewardOAuthCallbackProps,
  // Component props
  StewardProviderProps,
  StewardTenantMembership,
  StewardTenantPickerProps,
  StewardUserButtonProps,
  // Tenant config
  TenantControlPlaneConfig,
  TenantFeatureFlags,
  TenantTheme,
  TransactionHistoryProps,
  TxRecord,
  TxStatus,
  WalletOverviewProps,
} from "./types.js";
// ─── Utilities ───
export {
  calcPercent,
  copyToClipboard,
  formatBalance,
  formatRelativeTime,
  formatTimestamp,
  formatWei,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  getStatusColor,
  truncateAddress,
} from "./utils/format.js";
export { DEFAULT_THEME, mergeTheme, themeToCSS } from "./utils/theme.js";
