// Re-export selected reusable UI from @elizaos/ui while keeping app-core's
// higher-level component surface intact.

// Inventory + wallet UI moved to @elizaos/app-wallet. These re-exports keep
// existing consumers working while they migrate.
// TODO: remove once consumers import directly from @elizaos/app-wallet.
export { ChainIcon } from "@elizaos/app-wallet/inventory/ChainIcon";
export {
  CHAIN_CONFIGS,
  type ChainConfig,
  type ChainKey,
  chainKeyToWalletRpcChain,
  getChainConfig,
  getContractLogoUrl,
  getExplorerTokenUrl,
  getExplorerTxUrl,
  getNativeLogoUrl,
  getStablecoinAddress,
  PRIMARY_CHAIN_KEYS,
  resolveChainKey,
} from "@elizaos/app-wallet/inventory/chainConfig";
export {
  BSC_GAS_READY_THRESHOLD,
  BSC_GAS_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
  type NftItem,
  type TokenRow,
  toNormalizedAddress,
} from "@elizaos/app-wallet/inventory/constants";
// InventoryView moved to @elizaos/app-wallet — re-exported for compatibility.
// TODO: remove once consumers import from @elizaos/app-wallet/ui.
export { InventoryView } from "@elizaos/app-wallet/ui";
export {
  ConfirmDialog as ConfirmModal,
  type ConfirmDialogProps as ConfirmModalProps,
  PromptDialog as PromptModal,
  type PromptDialogProps as PromptModalProps,
  SaveFooter as ConfigSaveFooter,
} from "@elizaos/ui";
export * from "../utils/knowledge-upload-image";
export * from "../utils/labels";
export * from "../utils/trajectory-format";
export * from "./apps/extensions/registry";
export * from "./apps/extensions/surface";
export * from "./apps/extensions/types";
export * from "./apps/GameView";
export * from "./apps/GameViewOverlay";
export * from "./apps/overlay-app-api";
export * from "./apps/overlay-app-registry";
export * from "./apps/surfaces/GameOperatorShell";
export * from "./apps/surfaces/registry";
export * from "./apps/surfaces/types";
export * from "./character/CharacterEditor";
export * from "./character/CharacterRoster";
export * from "./character/character-greeting";
export * from "./chat/AgentActivityBox";
export * from "./chat/MessageContent";
export * from "./chat/SaveCommandModal";
export * from "./chat/TasksEventsPanel";
export * from "./chat/widgets/registry";
export * from "./chat/widgets/shared";
export * from "./chat/widgets/types";
export * from "./cloud/CloudSourceControls";
export * from "./config-ui";
export * from "./connectors/BlueBubblesStatusPanel";
export * from "./connectors/ConnectorSetupPanel";
export * from "./connectors/DiscordLocalConnectorPanel";
export * from "./connectors/SignalQrOverlay";
export * from "./connectors/WhatsAppQrOverlay";
export * from "./conversations/ConversationsSidebar";
export * from "./conversations/conversation-utils";
export * from "./custom-actions/CustomActionEditor";
export * from "./custom-actions/CustomActionsPanel";
export * from "./custom-actions/CustomActionsView";
export * from "./pages/AppsPageView";
export * from "./pages/AppsView";
export * from "./pages/AutomationsView";
export * from "./pages/BrowserWorkspaceView";
export * from "./pages/ChatModalView";
export * from "./pages/ChatView";
export * from "./pages/ConfigPageView";
export * from "./pages/ConnectorsPageView";
export * from "./pages/DatabasePageView";
export * from "./pages/DatabaseView";
export * from "./pages/ElizaCloudDashboard";
export * from "./pages/HeartbeatsView";
export * from "./pages/KnowledgeView";

export * from "./pages/LogsView";
export * from "./pages/MediaGalleryView";
export * from "./pages/MemoryViewerView";
export * from "./pages/PageScopedChatPane";
export * from "./pages/PluginsPageView";
export * from "./pages/PluginsView";
export * from "./pages/RelationshipsView";
export * from "./pages/ReleaseCenterView";
export * from "./pages/RuntimeView";
export * from "./pages/SecretsView";
export * from "./pages/SettingsView";
export * from "./pages/SkillsView";
export * from "./pages/StreamView";
export * from "./pages/TasksPageView";
export * from "./pages/TrajectoriesView";
export * from "./pages/TrajectoryDetailView";
export * from "./pages/TriggersView";
export * from "./pages/VectorBrowserView";
export * from "./settings/ApiKeyConfig";
export * from "./settings/DesktopWorkspaceSection";
export * from "./settings/PermissionsSection";
export * from "./settings/PolicyControlsView";
export * from "./settings/ProviderSwitcher";
export * from "./settings/permission-types";
export * from "./settings/SubscriptionStatus";
export * from "./settings/VoiceConfigView";
export * from "./shared/confirm-delete-control";
export * from "./shared/LanguageDropdown";
export * from "./shared/ThemeToggle";
export * from "./shell/BugReportModal";
export * from "./shell/CommandPalette";
export * from "./shell/ConnectionFailedBanner";
export * from "./shell/ConnectionLostOverlay";
export * from "./shell/Header";
export * from "./shell/LoadingScreen";
export * from "./shell/PairingView";
export * from "./shell/RestartBanner";
export * from "./shell/ShellOverlays";
export * from "./shell/ShortcutsOverlay";
export * from "./shell/StartupFailureView";
export * from "./shell/StartupShell";
export * from "./shell/SystemWarningBanner";
export * from "./workspace/AppWorkspaceChrome";
