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

import { useCallback, useEffect, useMemo, useState } from "react";
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

export function useMiscUiState() {
  // ── Command palette ────────────────────────────────────────────────
  const [commandPaletteOpen, _setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);

  // ── Emote picker ───────────────────────────────────────────────────
  const [emotePickerOpen, setEmotePickerOpen] = useState(false);

  // ── MCP ────────────────────────────────────────────────────────────
  const [mcpConfiguredServers, setMcpConfiguredServers] = useState<
    Record<string, McpServerConfig>
  >({});
  const [mcpServerStatuses, setMcpServerStatuses] = useState<McpServerStatus[]>(
    [],
  );
  const [mcpMarketplaceQuery, setMcpMarketplaceQuery] = useState("");
  const [mcpMarketplaceResults, setMcpMarketplaceResults] = useState<
    McpMarketplaceResult[]
  >([]);
  const [mcpMarketplaceLoading, setMcpMarketplaceLoading] = useState(false);
  const [mcpAction, setMcpAction] = useState("");
  const [mcpAddingServer, setMcpAddingServer] =
    useState<McpRegistryServerDetail | null>(null);
  const [mcpAddingResult, setMcpAddingResult] =
    useState<McpMarketplaceResult | null>(null);
  const [mcpEnvInputs, setMcpEnvInputs] = useState<Record<string, string>>({});
  const [mcpHeaderInputs, setMcpHeaderInputs] = useState<
    Record<string, string>
  >({});

  // ── Share ingest / dropped files ───────────────────────────────────
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const [shareIngestNotice, setShareIngestNotice] = useState("");

  // ── Game ───────────────────────────────────────────────────────────
  const [appRuns, setAppRuns] = useState<AppRunSummary[]>([]);
  const [activeGameRunId, setActiveGameRunIdRaw] = useState(() => {
    try {
      return sessionStorage.getItem("eliza:activeGameRunId") ?? "";
    } catch {
      return "";
    }
  });
  const setActiveGameRunId = useCallback((id: string) => {
    setActiveGameRunIdRaw(id);
    try {
      if (id) sessionStorage.setItem("eliza:activeGameRunId", id);
      else sessionStorage.removeItem("eliza:activeGameRunId");
    } catch {
      /* ignore */
    }
  }, []);
  const [gameOverlayEnabled, setGameOverlayEnabled] = useState(false);
  const [activeOverlayApp, setActiveOverlayApp] = useState<string | null>(null);
  const companionAppRunning = activeOverlayApp === "@elizaos/app-companion";

  const activeGameRun = useMemo(
    () => appRuns.find((run) => run.runId === activeGameRunId) ?? null,
    [activeGameRunId, appRuns],
  );
  const activeGameApp = activeGameRun?.appName ?? "";
  const activeGameDisplayName = activeGameRun?.displayName ?? "";
  const activeGameViewerUrl = activeGameRun?.viewer?.url ?? "";
  const activeGameSandbox =
    activeGameRun?.viewer?.sandbox ??
    "allow-scripts allow-same-origin allow-popups";
  const activeGamePostMessageAuth = Boolean(
    activeGameRun?.viewer?.postMessageAuth,
  );
  const activeGamePostMessagePayload =
    activeGameRun?.viewer?.authMessage ?? null;
  const activeGameSession =
    (activeGameRun?.session as AppSessionState | null) ?? null;

  useEffect(() => {
    if (!activeGameRunId) return;
    if (appRuns.some((run) => run.runId === activeGameRunId)) return;
    setActiveGameRunId("");
  }, [activeGameRunId, appRuns, setActiveGameRunId]);

  // ── Messages sidebar ───────────────────────────────────────
  const [activeInboxChat, setActiveInboxChat] =
    useState<ActiveInboxChat | null>(null);

  // ── Terminal channel ───────────────────────────────────────────────
  // Selected PTY session id when the Terminal channel is active.
  // Mutually exclusive with activeInboxChat / activeConversationId.
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<
    string | null
  >(null);

  // ── Callbacks ──────────────────────────────────────────────────────

  const closeCommandPalette = useCallback(() => {
    _setCommandPaletteOpen(false);
    setCommandQuery("");
    setCommandActiveIndex(0);
  }, []);

  const openEmotePicker = useCallback(() => {
    setEmotePickerOpen(true);
  }, []);

  const closeEmotePicker = useCallback(() => {
    setEmotePickerOpen(false);
  }, []);

  // ── Analysis Mode ───────────────────────────────────────────────────
  const [analysisMode, setAnalysisMode] = useState(false);

  return {
    state: {
      analysisMode,
      commandPaletteOpen,
      commandQuery,
      commandActiveIndex,
      emotePickerOpen,
      mcpConfiguredServers,
      mcpServerStatuses,
      mcpMarketplaceQuery,
      mcpMarketplaceResults,
      mcpMarketplaceLoading,
      mcpAction,
      mcpAddingServer,
      mcpAddingResult,
      mcpEnvInputs,
      mcpHeaderInputs,
      droppedFiles,
      shareIngestNotice,
      appRuns,
      activeGameRunId,
      activeGameApp,
      activeGameDisplayName,
      activeGameViewerUrl,
      activeGameSandbox,
      activeGamePostMessageAuth,
      activeGamePostMessagePayload,
      activeGameSession,
      gameOverlayEnabled,
      companionAppRunning,
      activeOverlayApp,
      activeInboxChat,
      activeTerminalSessionId,
    },
    setActiveInboxChat,
    setActiveTerminalSessionId,
    setAnalysisMode,
    setCommandQuery,
    setCommandActiveIndex,
    setEmotePickerOpen,
    setMcpConfiguredServers,
    setMcpServerStatuses,
    setMcpMarketplaceQuery,
    setMcpMarketplaceResults,
    setMcpMarketplaceLoading,
    setMcpAction,
    setMcpAddingServer,
    setMcpAddingResult,
    setMcpEnvInputs,
    setMcpHeaderInputs,
    setDroppedFiles,
    setShareIngestNotice,
    setAppRuns,
    setActiveGameRunId,
    setGameOverlayEnabled,
    setActiveOverlayApp,
    closeCommandPalette,
    openEmotePicker,
    closeEmotePicker,
  };
}
