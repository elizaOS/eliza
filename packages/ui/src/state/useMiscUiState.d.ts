/**
 * Miscellaneous UI state — extracted from AppContext.
 *
 * Covers three loosely-coupled UI domains that don't warrant their
 * own dedicated hook files:
 *
 *  - MCP: configured servers, statuses, marketplace flow
 *  - Games: active game iframe state and overlay flag
 *  - UI chrome: command palette, emote picker, dropped files
 */
import type {
  AppRunSummary,
  AppSessionState,
  McpMarketplaceResult,
  McpRegistryServerDetail,
  McpServerConfig,
  McpServerStatus,
} from "../api";
/**
 * Currently-selected connector chat in the messages sidebar.
 * When non-null, ChatView swaps its main panel out for a read-only
 * view of that room's inbox messages (rendered via `/api/inbox/
 * messages?roomId=…`). Mutually exclusive with a live dashboard
 * conversation — the sidebar clears one when selecting the other.
 */
export interface ActiveInboxChat {
  avatarUrl?: string;
  canSend?: boolean;
  id: string;
  source: string;
  transportSource?: string;
  title: string;
  worldId?: string;
  worldLabel?: string;
}
export declare function useMiscUiState(): {
  state: {
    analysisMode: boolean;
    commandPaletteOpen: boolean;
    commandQuery: string;
    commandActiveIndex: number;
    emotePickerOpen: boolean;
    mcpConfiguredServers: Record<string, McpServerConfig>;
    mcpServerStatuses: McpServerStatus[];
    mcpMarketplaceQuery: string;
    mcpMarketplaceResults: McpMarketplaceResult[];
    mcpMarketplaceLoading: boolean;
    mcpAction: string;
    mcpAddingServer: McpRegistryServerDetail | null;
    mcpAddingResult: McpMarketplaceResult | null;
    mcpEnvInputs: Record<string, string>;
    mcpHeaderInputs: Record<string, string>;
    droppedFiles: string[];
    shareIngestNotice: string;
    appRuns: AppRunSummary[];
    activeGameRunId: string;
    activeGameApp: string;
    activeGameDisplayName: string;
    activeGameViewerUrl: string;
    activeGameSandbox: string;
    activeGamePostMessageAuth: boolean;
    activeGamePostMessagePayload:
      | import("@elizaos/shared").AppViewerAuthMessage
      | null;
    activeGameSession: AppSessionState | null;
    gameOverlayEnabled: boolean;
    companionAppRunning: boolean;
    activeOverlayApp: string | null;
    activeInboxChat: ActiveInboxChat | null;
    activeTerminalSessionId: string | null;
  };
  setActiveInboxChat: import("react").Dispatch<
    import("react").SetStateAction<ActiveInboxChat | null>
  >;
  setActiveTerminalSessionId: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setAnalysisMode: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setCommandQuery: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setCommandActiveIndex: import("react").Dispatch<
    import("react").SetStateAction<number>
  >;
  setEmotePickerOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setMcpConfiguredServers: import("react").Dispatch<
    import("react").SetStateAction<Record<string, McpServerConfig>>
  >;
  setMcpServerStatuses: import("react").Dispatch<
    import("react").SetStateAction<McpServerStatus[]>
  >;
  setMcpMarketplaceQuery: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setMcpMarketplaceResults: import("react").Dispatch<
    import("react").SetStateAction<McpMarketplaceResult[]>
  >;
  setMcpMarketplaceLoading: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setMcpAction: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setMcpAddingServer: import("react").Dispatch<
    import("react").SetStateAction<McpRegistryServerDetail | null>
  >;
  setMcpAddingResult: import("react").Dispatch<
    import("react").SetStateAction<McpMarketplaceResult | null>
  >;
  setMcpEnvInputs: import("react").Dispatch<
    import("react").SetStateAction<Record<string, string>>
  >;
  setMcpHeaderInputs: import("react").Dispatch<
    import("react").SetStateAction<Record<string, string>>
  >;
  setDroppedFiles: import("react").Dispatch<
    import("react").SetStateAction<string[]>
  >;
  setShareIngestNotice: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setAppRuns: import("react").Dispatch<
    import("react").SetStateAction<AppRunSummary[]>
  >;
  setActiveGameRunId: (id: string) => void;
  setGameOverlayEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setActiveOverlayApp: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  closeCommandPalette: () => void;
  openEmotePicker: () => void;
  closeEmotePicker: () => void;
};
//# sourceMappingURL=useMiscUiState.d.ts.map
