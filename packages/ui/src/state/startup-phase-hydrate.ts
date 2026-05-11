/**
 * startup-phase-hydrate.ts
 *
 * Side-effect logic for the "hydrating" startup phase and the persistent
 * "ready" phase (WebSocket bindings, nav listener).
 */

import type { AgentStatus, WalletAddresses } from "../api";
import {
  type CodingAgentSession,
  type Conversation,
  type ConversationMessage,
  client,
  type StreamEventEnvelope,
} from "../api";
import { mapServerTasksToSessions } from "../chat/coding-agent-session-state";
import { prefetchAppsCatalog } from "../components/apps/load-apps-catalog";
import { type AppEmoteEventDetail, dispatchAppEmoteEvent } from "../events";
import {
  getWindowNavigationPath,
  isRouteRootPath,
  shouldUseHashNavigation,
  type Tab,
  tabFromPath,
} from "../navigation";
import { resolveApiUrl } from "../utils";
import {
  loadAvatarIndex,
  normalizeAvatarIndex,
  parseAgentStatusEvent,
  parseProactiveMessageEvent,
  parseStreamEventEnvelopeEvent,
} from "./internal";
import { shouldStartAtCharacterSelectOnLaunch } from "./shell-routing";
import type { StartupEvent } from "./startup-coordinator";
import type { OnboardingMode } from "./types";

export interface HydratingDeps {
  setStartupError: (v: null) => void;
  setOnboardingLoading: (v: boolean) => void;
  hydrateInitialConversationState: () => Promise<string | null>;
  requestGreetingWhenRunningRef: React.RefObject<
    (convId: string) => Promise<void>
  >;
  loadWorkbench: () => Promise<void>;
  loadPlugins: () => Promise<void>;
  loadSkills: () => Promise<void>;
  loadCharacter: () => Promise<void>;
  loadWalletConfig: () => Promise<void>;
  loadInventory: () => Promise<void>;
  loadUpdateStatus: (force?: boolean) => Promise<void>;
  checkExtensionStatus: () => Promise<void>;
  pollCloudCredits: () => void;
  fetchAutonomyReplay: () => Promise<void>;
  setSelectedVrmIndex: (v: number) => void;
  setCustomVrmUrl: (v: string) => void;
  setCustomBackgroundUrl: (v: string) => void;
  setWalletAddresses: (v: WalletAddresses) => void;
  setTab: (t: Tab) => void;
  setTabRaw: (t: Tab) => void;
  onboardingCompletionCommittedRef: React.MutableRefObject<boolean>;
  initialTabSetRef: React.MutableRefObject<boolean>;
  onboardingMode: OnboardingMode;
}

export interface ReadyPhaseDeps {
  setAgentStatusIfChanged: (v: AgentStatus) => void;
  setPendingRestart: (v: boolean | ((prev: boolean) => boolean)) => void;
  setPendingRestartReasons: (
    v: string[] | ((prev: string[]) => string[]),
  ) => void;
  setSystemWarnings: (v: string[] | ((prev: string[]) => string[])) => void;
  showRestartBanner: () => void;
  setPtySessions: (
    v:
      | CodingAgentSession[]
      | ((prev: CodingAgentSession[]) => CodingAgentSession[]),
  ) => void;
  /** Ref whose .current is true when there are active PTY sessions. */
  hasPtySessionsRef: React.MutableRefObject<boolean>;
  setTabRaw: (t: Tab) => void;
  setConversationMessages: (
    v:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => void;
  setUnreadConversations: (
    v: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void;
  setConversations: (
    v: Conversation[] | ((prev: Conversation[]) => Conversation[]),
  ) => void;
  appendAutonomousEvent: (event: StreamEventEnvelope) => void;
  notifyAssistantEvent: (event: StreamEventEnvelope) => void;
  notifyHeartbeatEvent: (event: StreamEventEnvelope) => void;
  loadPlugins: () => Promise<void>;
  loadWalletConfig: () => Promise<void>;
  pollCloudCredits: () => void;
  activeConversationIdRef: React.RefObject<string | null>;
  elizaCloudPollInterval: React.MutableRefObject<number | null>;
  elizaCloudLoginPollTimer: React.MutableRefObject<number | null>;
}

function normalizeAppEmoteEvent(
  data: Record<string, unknown>,
): AppEmoteEventDetail | null {
  const emoteId = typeof data.emoteId === "string" ? data.emoteId : null;
  const path =
    typeof data.path === "string"
      ? data.path
      : typeof data.glbPath === "string"
        ? data.glbPath
        : null;
  if (!emoteId || !path) return null;
  return {
    emoteId,
    path,
    duration:
      typeof data.duration === "number" && Number.isFinite(data.duration)
        ? data.duration
        : 3,
    loop: data.loop === true,
    showOverlay: data.showOverlay !== false,
  };
}

function shouldNotifyDesktopForAssistantEvent(
  event: StreamEventEnvelope,
): boolean {
  if (event.type !== "agent_event" || event.stream !== "assistant") {
    return false;
  }
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return false;
  }
  return payload.source === "lifeops-reminder";
}

const DEFAULT_LANDING_TAB: Tab = "chat";

/**
 * Runs the hydrating phase.
 * Loads initial conversation state, wallet, avatar, plugins, and sets the tab.
 * Dispatches HYDRATION_COMPLETE when done.
 */
export async function runHydrating(
  deps: HydratingDeps,
  dispatch: (event: StartupEvent) => void,
  cancelled: { current: boolean },
): Promise<void> {
  const isTransientOptionalFetchFailure = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    const maybeApiError = err as Error & {
      kind?: string;
      path?: string;
    };
    return (
      err.name === "ApiError" &&
      maybeApiError.kind === "network" &&
      /^(Failed to fetch|Request aborted)$/i.test(err.message)
    );
  };
  const warn = (scope: string, err: unknown) => {
    if (isTransientOptionalFetchFailure(err)) return;
    console.warn(`[eliza][startup:init] ${scope}`, err);
  };

  deps.setStartupError(null);
  // Start the WS bridge before history hydration finishes so restored-session
  // flows regain live updates without waiting for conversation restore.
  client.connectWs();
  const greetConvId = await deps.hydrateInitialConversationState();
  deps.setOnboardingLoading(false);
  if (greetConvId) void deps.requestGreetingWhenRunningRef.current(greetConvId);

  void deps.loadWorkbench();
  void deps.loadPlugins();
  void deps.loadCharacter();

  // Wallet addresses
  try {
    deps.setWalletAddresses(await client.getWalletAddresses());
  } catch (e: unknown) {
    warn("wallet addresses", e);
  }

  // Avatar / VRM selection — resolve from server config, then stream
  // settings, then localStorage.  Cloud containers that skip onboarding
  // have their character defaults written server-side, so we must read
  // the config to pick up the correct avatarIndex.
  let resolvedIdx = loadAvatarIndex();
  try {
    const cfg = await client.getConfig();
    const cfgUi = cfg?.ui as Record<string, unknown> | undefined;
    const cfgAvatarIdx = cfgUi?.avatarIndex;
    if (typeof cfgAvatarIdx === "number" && Number.isFinite(cfgAvatarIdx)) {
      const normalized = normalizeAvatarIndex(cfgAvatarIdx);
      if (normalized > 0) {
        resolvedIdx = normalized;
        deps.setSelectedVrmIndex(resolvedIdx);
      }
    }
  } catch (e: unknown) {
    warn("config avatar index", e);
  }
  try {
    if (typeof client.getStreamSettings === "function") {
      const stream = await client.getStreamSettings();
      const si = stream.settings?.avatarIndex;
      if (typeof si === "number" && Number.isFinite(si)) {
        resolvedIdx = normalizeAvatarIndex(si);
        deps.setSelectedVrmIndex(resolvedIdx);
      }
    }
  } catch (e: unknown) {
    warn("stream settings avatar", e);
  }
  if (resolvedIdx === 0) {
    if (await client.hasCustomVrm())
      deps.setCustomVrmUrl(resolveApiUrl(`/api/avatar/vrm?t=${Date.now()}`));
    else deps.setSelectedVrmIndex(1);
    if (await client.hasCustomBackground())
      deps.setCustomBackgroundUrl(
        resolveApiUrl(`/api/avatar/background?t=${Date.now()}`),
      );
  }

  // Warm the apps catalog cache so the Apps tab opens with the real
  // sections instead of the placeholder skeleton. Fire-and-forget; the
  // Apps view also loads on its own mount as a fallback.
  void prefetchAppsCatalog();

  void deps.pollCloudCredits();
  await deps.fetchAutonomyReplay();

  // Tab routing
  const navPath = getWindowNavigationPath();
  const urlTab = tabFromPath(navPath);
  const isRoot = isRouteRootPath(navPath);
  const shouldCharSelect =
    deps.onboardingCompletionCommittedRef.current ||
    shouldStartAtCharacterSelectOnLaunch({
      onboardingNeedsOptions: false,
      onboardingMode: deps.onboardingMode,
      navPath,
      urlTab,
    });
  if (!deps.initialTabSetRef.current) {
    deps.initialTabSetRef.current = true;
    if (shouldCharSelect) {
      deps.onboardingCompletionCommittedRef.current = false;
      deps.setTab("character-select");
      void deps.loadCharacter();
    } else if (isRoot) deps.setTab(DEFAULT_LANDING_TAB);
  }
  if (urlTab && urlTab !== "chat" && urlTab !== "companion") {
    deps.setTabRaw(urlTab);
    if (urlTab === "plugins") {
      void deps.loadPlugins();
      void deps.loadSkills();
    }
    if (urlTab === "settings") {
      void deps.checkExtensionStatus();
      void deps.loadWalletConfig();
      void deps.loadCharacter();
      void deps.loadUpdateStatus();
      void deps.loadPlugins();
    }
    if (urlTab === "character" || urlTab === "character-select")
      void deps.loadCharacter();
    if (urlTab === "inventory") void deps.loadInventory();
  }

  if (!cancelled.current) dispatch({ type: "HYDRATION_COMPLETE" });
}

/**
 * Sets up persistent WebSocket bindings and the navigation listener.
 * Returns a cleanup function that unbinds everything.
 * Should be called once when the coordinator first reaches "ready".
 */
export function bindReadyPhase(
  depsRef: React.MutableRefObject<ReadyPhaseDeps | undefined>,
): () => void {
  let ptyPollInterval: ReturnType<typeof setInterval> | null = null;
  let handleVis: (() => void) | null = null;

  const hydratePty = () => {
    client
      .getCodingAgentStatus()
      .then((s) => {
        if (s?.tasks)
          depsRef.current?.setPtySessions(mapServerTasksToSessions(s.tasks));
      })
      .catch(() => {});
  };
  hydratePty();
  let ptyHydratedViaWs = false;
  // Only re-poll when sessions are active — avoids unnecessary 5-second API
  // calls during idle. WS events handle session discovery; ws-reconnected and
  // visibility-change handlers trigger an unconditional hydrate on recovery.
  ptyPollInterval = setInterval(() => {
    if (depsRef.current?.hasPtySessionsRef.current) hydratePty();
  }, 5_000);

  client.connectWs();

  const unbindEmotes = client.onWsEvent(
    "emote",
    (data: Record<string, unknown>) => {
      const e = normalizeAppEmoteEvent(data);
      if (e) dispatchAppEmoteEvent(e);
    },
  );
  const unbindWsReconnect = client.onWsEvent("ws-reconnected", () =>
    Promise.resolve().then(() => {
      hydratePty();
      void depsRef.current?.loadWalletConfig();
      void depsRef.current?.pollCloudCredits();
    }),
  );
  const unbindSysWarn = client.onWsEvent(
    "system-warning",
    (data: Record<string, unknown>) => {
      const msg = typeof data.message === "string" ? data.message : "";
      if (msg)
        depsRef.current?.setSystemWarnings((prev: string[]) => {
          if (prev.includes(msg)) return prev;
          const n = [...prev, msg];
          if (n.length > 50) n.splice(0, n.length - 50);
          return n;
        });
    },
  );

  handleVis = () => {
    if (document.visibilityState === "visible") hydratePty();
  };
  document.addEventListener("visibilitychange", handleVis);

  const unbindStatus = client.onWsEvent(
    "status",
    (data: Record<string, unknown>) => {
      const d = depsRef.current;
      if (!d) return;
      const ns = parseAgentStatusEvent(data);
      if (ns) {
        d.setAgentStatusIfChanged(ns);
        if (data.restarted) {
          d.setPendingRestart(false);
          d.setPendingRestartReasons([]);
          void d.loadPlugins();
          void d.loadWalletConfig();
          void d.pollCloudCredits();
          hydratePty();
          ptyHydratedViaWs = true;
        }
      }
      if (!ptyHydratedViaWs) {
        ptyHydratedViaWs = true;
        hydratePty();
      }
      if (typeof data.pendingRestart === "boolean")
        d.setPendingRestart((p: boolean) =>
          p === data.pendingRestart ? p : (data.pendingRestart as boolean),
        );
      if (Array.isArray(data.pendingRestartReasons)) {
        const nr = data.pendingRestartReasons.filter(
          (e): e is string => typeof e === "string",
        );
        d.setPendingRestartReasons((p: string[]) =>
          p.length === nr.length && p.every((r, i) => r === nr[i]) ? p : nr,
        );
      }
    },
  );

  const unbindRestart = client.onWsEvent(
    "restart-required",
    (data: Record<string, unknown>) => {
      if (Array.isArray(data.reasons)) {
        depsRef.current?.setPendingRestartReasons(
          data.reasons.filter((e): e is string => typeof e === "string"),
        );
        depsRef.current?.setPendingRestart(true);
        depsRef.current?.showRestartBanner();
      }
    },
  );

  const unbindAgent = client.onWsEvent(
    "agent_event",
    (data: Record<string, unknown>) => {
      const e = parseStreamEventEnvelopeEvent(data);
      if (e) {
        depsRef.current?.appendAutonomousEvent(e);
        if (shouldNotifyDesktopForAssistantEvent(e)) {
          depsRef.current?.notifyAssistantEvent(e);
        }
      }
    },
  );
  const unbindHb = client.onWsEvent(
    "heartbeat_event",
    (data: Record<string, unknown>) => {
      const e = parseStreamEventEnvelopeEvent(data);
      if (e) {
        depsRef.current?.appendAutonomousEvent(e);
        depsRef.current?.notifyHeartbeatEvent(e);
      }
    },
  );

  const unbindProactive = client.onWsEvent(
    "proactive-message",
    (data: Record<string, unknown>) => {
      const parsed = parseProactiveMessageEvent(data);
      if (!parsed) return;
      const { conversationId: cid, message: msg } = parsed;
      const d = depsRef.current;
      if (!d) return;
      if (cid === d.activeConversationIdRef.current)
        d.setConversationMessages((prev: ConversationMessage[]) =>
          prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
        );
      else
        d.setUnreadConversations(
          (prev: Set<string>) => new Set([...prev, cid]),
        );
      if (msg.source && msg.source !== "client_chat" && msg.role === "user")
        d.appendAutonomousEvent({
          type: "agent_event",
          version: 1,
          eventId: `synth-${msg.id}`,
          ts: msg.timestamp,
          stream: "message",
          payload: {
            text: msg.text,
            from: msg.from,
            source: msg.source,
            direction: "inbound",
            channel: msg.source,
          },
        } as StreamEventEnvelope);
      d.setConversations((prev: Conversation[]) => {
        const u = prev.map((c) =>
          c.id === cid ? { ...c, updatedAt: new Date().toISOString() } : c,
        );
        return u.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
      });
    },
  );

  const unbindConvUp = client.onWsEvent(
    "conversation-updated",
    (data: Record<string, unknown>) => {
      const conv = data.conversation as Conversation;
      if (conv?.id)
        depsRef.current?.setConversations((prev: Conversation[]) => {
          const u = prev.map((c) => {
            if (c.id !== conv.id) return c;
            // Don't let a WS update overwrite a meaningful title with a
            // generic/default one (e.g. "default", "New Chat", empty).
            const incomingTitle = conv.title?.trim();
            const existingTitle = c.title?.trim();
            const isGenericTitle =
              !incomingTitle ||
              incomingTitle === "default" ||
              incomingTitle === "New Chat";
            if (
              isGenericTitle &&
              existingTitle &&
              !existingTitle.startsWith("New Chat")
            ) {
              return { ...conv, title: existingTitle };
            }
            return conv;
          });
          return u.sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          );
        });
    },
  );

  const unbindPty = client.onWsEvent(
    "pty-session-event",
    (data: Record<string, unknown>) => {
      const eventType = (data.eventType ?? data.type) as string;
      const sid = data.sessionId as string;
      if (!sid) return;
      if (eventType === "task_registered") {
        const dd = data.data as Record<string, unknown> | undefined;
        depsRef.current?.setPtySessions((prev: CodingAgentSession[]) => [
          ...prev.filter((s) => s.sessionId !== sid),
          {
            sessionId: sid,
            agentType: (dd?.agentType as string) ?? "claude",
            label: (dd?.label as string) ?? sid,
            originalTask: (dd?.originalTask as string) ?? "",
            workdir: (dd?.workdir as string) ?? "",
            status: "active",
            decisionCount: 0,
            autoResolvedCount: 0,
            lastActivity: "Starting",
          },
        ]);
      } else if (eventType === "task_complete" || eventType === "stopped") {
        depsRef.current?.setPtySessions((prev: CodingAgentSession[]) =>
          prev.filter((s) => s.sessionId !== sid),
        );
      } else {
        let needsHydrate = false;
        depsRef.current?.setPtySessions((prev: CodingAgentSession[]) => {
          const known = prev.some((s) => s.sessionId === sid);
          if (!known) {
            needsHydrate = true;
            return prev;
          }
          const dd = data.data as Record<string, unknown> | undefined;
          if (eventType === "blocked" || eventType === "escalation")
            return prev.map((s) =>
              s.sessionId === sid
                ? {
                    ...s,
                    status: "blocked" as const,
                    lastActivity:
                      eventType === "escalation"
                        ? "Escalated — needs attention"
                        : "Waiting for input",
                  }
                : s,
            );
          if (eventType === "tool_running") {
            const td =
              (dd?.description as string) ??
              (dd?.toolName as string) ??
              "external tool";
            return prev.map((s) =>
              s.sessionId === sid
                ? {
                    ...s,
                    status: "tool_running" as const,
                    toolDescription: td,
                    lastActivity: `Running ${td}`.slice(0, 60),
                  }
                : s,
            );
          }
          if (eventType === "blocked_auto_resolved") {
            const p = (dd?.prompt as string) ?? (dd?.reasoning as string) ?? "";
            return prev.map((s) =>
              s.sessionId === sid
                ? {
                    ...s,
                    status: "active" as const,
                    toolDescription: undefined,
                    lastActivity: p
                      ? `Approved: ${p}`.slice(0, 60)
                      : "Approved",
                  }
                : s,
            );
          }
          if (eventType === "coordination_decision") {
            const r = (dd?.reasoning as string) ?? (dd?.action as string) ?? "";
            const esc = (dd?.action as string) === "escalate";
            return prev.map((s) =>
              s.sessionId === sid
                ? {
                    ...s,
                    status: "active" as const,
                    toolDescription: undefined,
                    lastActivity: (esc
                      ? `Escalated: ${r}`
                      : r
                        ? `Responded: ${r}`
                        : "Responded"
                    ).slice(0, 60),
                  }
                : s,
            );
          }
          if (eventType === "ready")
            return prev.map((s) =>
              s.sessionId === sid
                ? {
                    ...s,
                    status: "active" as const,
                    toolDescription: undefined,
                    lastActivity: "Running",
                  }
                : s,
            );
          if (eventType === "error") {
            const em = (dd?.message as string) ?? "Unknown error";
            return prev.map((s) =>
              s.sessionId === sid
                ? {
                    ...s,
                    status: "error" as const,
                    lastActivity: `Error: ${em}`.slice(0, 60),
                  }
                : s,
            );
          }
          return prev;
        });
        if (needsHydrate) hydratePty();
      }
    },
  );

  // Navigation listener
  const navEvt = shouldUseHashNavigation() ? "hashchange" : "popstate";
  const handleNav = () => {
    const t = tabFromPath(getWindowNavigationPath());
    if (t) depsRef.current?.setTabRaw(t);
  };
  if (typeof window !== "undefined") window.addEventListener(navEvt, handleNav);

  return () => {
    if (typeof window !== "undefined")
      window.removeEventListener(navEvt, handleNav);
    if (depsRef.current?.elizaCloudPollInterval.current) {
      clearInterval(depsRef.current.elizaCloudPollInterval.current);
      depsRef.current.elizaCloudPollInterval.current = null;
    }
    if (depsRef.current?.elizaCloudLoginPollTimer.current) {
      clearInterval(depsRef.current.elizaCloudLoginPollTimer.current);
      depsRef.current.elizaCloudLoginPollTimer.current = null;
    }
    unbindStatus();
    unbindAgent();
    unbindHb();
    unbindEmotes();
    unbindProactive();
    unbindWsReconnect();
    unbindSysWarn();
    unbindRestart();
    unbindConvUp();
    unbindPty();
    if (ptyPollInterval) clearInterval(ptyPollInterval);
    if (handleVis) document.removeEventListener("visibilitychange", handleVis);
    client.disconnectWs();
  };
}
