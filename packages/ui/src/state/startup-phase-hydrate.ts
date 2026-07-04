/**
 * startup-phase-hydrate.ts
 *
 * Side-effect logic for the "hydrating" startup phase and the persistent
 * "ready" phase (WebSocket bindings, nav listener).
 */

import { MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import {
  createNavigateViewEvent,
  normalizeShellNavigateViewPayload,
  SHELL_NAVIGATE_VIEW_WS_EVENT,
} from "@elizaos/shared/events";
import type { AgentStatus, WalletAddresses } from "../api";
import {
  type CodingAgentSession,
  type Conversation,
  type ConversationMessage,
  client,
  type StreamEventEnvelope,
} from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { mapServerTasksToSessions } from "../chat/coding-agent-session-state";
import { prefetchAppsCatalog } from "../components/apps/load-apps-catalog";
import {
  type AppEmoteEventDetail,
  dispatchAppEmoteEvent,
  dispatchVoiceControl,
} from "../events";
import {
  getWindowNavigationPath,
  isRouteRootPath,
  resolveDefaultLandingTab,
  shouldUseHashNavigation,
  type Tab,
  tabFromPath,
} from "../navigation";
import { isTransientOptionalFetchFailure } from "../utils";
import { emitViewEvent } from "../views/view-event-bus";
import type { ActionTone } from "./action-notice";
import {
  loadAgentProfileRegistry,
  resolveAgentProfileByQuery,
} from "./agent-profiles";
import {
  loadAvatarIndex,
  normalizeAvatarIndex,
  parseAgentStatusEvent,
  parseProactiveMessageEvent,
  parseStreamEventEnvelopeEvent,
} from "./internal";
import { shouldStartAtCharacterSelectOnLaunch } from "./shell-routing";
import type { StartupEvent } from "./startup-coordinator";
import { switchRuntimeNonDestructive } from "./switch-runtime";

export interface HydratingDeps {
  setStartupError: (v: null) => void;
  setFirstRunLoading: (v: boolean) => void;
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
  setWalletAddresses: (v: WalletAddresses) => void;
  setTab: (t: Tab) => void;
  setTabRaw: (t: Tab) => void;
  firstRunCompletionCommittedRef: React.MutableRefObject<boolean>;
  initialTabSetRef: React.MutableRefObject<boolean>;
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
  /** Ref whose .current is true when the agent runtime state is "running". */
  agentRunningRef: React.MutableRefObject<boolean>;
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
  notifyHeartbeatEvent: (event: StreamEventEnvelope) => void;
  loadPlugins: () => Promise<void>;
  loadWalletConfig: () => Promise<void>;
  pollCloudCredits: () => void;
  activeConversationIdRef: React.RefObject<string | null>;
  elizaCloudPollInterval: React.MutableRefObject<number | null>;
  elizaCloudLoginPollTimer: React.MutableRefObject<number | null>;
  /** Transient shell toast — confirms agent-driven model/agent switches. */
  setActionNotice: (
    text: string,
    tone?: ActionTone,
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;
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

/**
 * Runs the hydrating phase.
 * Loads initial conversation state, wallet, avatar, plugins, and sets the tab.
 * Dispatches HYDRATION_COMPLETE when done.
 */
export async function runHydrating(
  deps: HydratingDeps,
  dispatch: (event: StartupEvent) => void,
  _cancelled: { current: boolean },
): Promise<void> {
  const warn = (scope: string, err: unknown) => {
    if (isTransientOptionalFetchFailure(err)) return;
    logger.warn(
      `[eliza][startup:init] ${scope}: ${err instanceof Error ? err.message : String(err)}`,
    );
  };

  deps.setStartupError(null);
  // Start the WS bridge before history hydration finishes so restored-session
  // flows regain live updates without waiting for conversation restore.
  client.connectWs();
  const greetConvId = await deps.hydrateInitialConversationState();
  deps.setFirstRunLoading(false);
  if (greetConvId) void deps.requestGreetingWhenRunningRef.current(greetConvId);

  const appShellRoutesSupported = supportsFullAppShellRoutes(
    client.getBaseUrl(),
  );

  if (appShellRoutesSupported) {
    void deps.loadWorkbench();
    void deps.loadPlugins();
  }
  void deps.loadCharacter();

  if (appShellRoutesSupported) {
    // Warm the apps catalog cache so the Apps tab opens with the real
    // sections instead of the placeholder skeleton. Fire-and-forget; the
    // Apps view also loads on its own mount as a fallback.
    void prefetchAppsCatalog();
  }

  void deps.pollCloudCredits();

  // Shell-decoration fetches (wallet addresses, avatar/VRM selection, autonomy
  // replay) are not needed to reach first paint: the composer only needs the
  // active conversation, restored above. Run them AFTER HYDRATION_COMPLETE so
  // they no longer sit on the ready critical path. No data is dropped — the
  // same setters are called as soon as the fetches resolve; the avatar/VRM
  // chain stays sequential because each step refines the resolved index, while
  // the independent wallet fetch runs in parallel. Fire-and-forget: a failure
  // here must never block or fail the boot.
  const decorateShellAfterReady = (): void => {
    if (appShellRoutesSupported) {
      void (async () => {
        try {
          deps.setWalletAddresses(await client.getWalletAddresses());
        } catch (e: unknown) {
          warn("wallet addresses", e);
        }
      })();
    }

    void (async () => {
      // Avatar / VRM selection — resolve from server config, then stream
      // settings, then localStorage.  Cloud containers that skip first-run
      // setup have their character defaults written server-side, so we must
      // read the config to pick up the correct avatarIndex.
      let resolvedIdx = loadAvatarIndex();
      try {
        const cfg = await client.getConfig();
        const cfgAvatarIdx = cfg.ui?.avatarIndex;
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
      // No avatar chosen by config/stream settings → fall back to the first
      // built-in avatar. (The old custom-VRM / custom-background existence
      // probes were removed with the 3D companion feature, #10434.)
      if (resolvedIdx === 0) deps.setSelectedVrmIndex(1);
    })();

    void (async () => {
      try {
        await deps.fetchAutonomyReplay();
      } catch (e: unknown) {
        warn("autonomy replay", e);
      }
    })();
  };

  // Tab routing
  const navPath = getWindowNavigationPath();
  const urlTab = tabFromPath(navPath);
  const isRoot = isRouteRootPath(navPath);
  // The post-first-run character-select landing only applies when the app was
  // opened at the root. A URL that names a specific view is an explicit deep
  // link and must win — otherwise this branch rewrote the URL to
  // /character/select while the `setTabRaw(urlTab)` pass below flipped the tab
  // back to the deep-linked view, leaving the URL and the rendered view
  // contradicting each other (and sometimes stranding the user on character
  // select instead of the view they asked for).
  const shouldCharSelect =
    (deps.firstRunCompletionCommittedRef.current ||
      shouldStartAtCharacterSelectOnLaunch({
        firstRunNeedsOptions: false,
        navPath,
        urlTab,
      })) &&
    (isRoot || !urlTab);
  if (!deps.initialTabSetRef.current) {
    deps.initialTabSetRef.current = true;
    if (shouldCharSelect) {
      deps.firstRunCompletionCommittedRef.current = false;
      deps.setTab("character-select");
      void deps.loadCharacter();
    } else if (isRoot) {
      deps.setTab(resolveDefaultLandingTab());
    } else {
      deps.firstRunCompletionCommittedRef.current = false;
    }
  }
  if (urlTab && urlTab !== "chat") {
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

  // HYDRATION_COMPLETE is the only signal that advances the coordinator out of
  // the "hydrating" phase. It must fire even if this run was cancelled: the
  // `cancelled` flag only guards against re-running side effects, but the
  // reducer treats HYDRATION_COMPLETE as a no-op in every phase other than
  // "hydrating" (RESET/SWITCH_AGENT have already moved on), so dispatching it
  // unconditionally can never cause a wrong transition. Suppressing it when the
  // hydrating effect re-runs (cleanup sets cancelled=true between the awaited
  // fetches) would strand the coordinator in "hydrating" forever, which keeps
  // the pre-agent home shell mounted and prevents /chat and /settings content
  // from ever rendering.
  dispatch({ type: "HYDRATION_COMPLETE" });

  // Decorate the shell after the ready gate so wallet/avatar/autonomy-replay
  // fetches no longer delay first paint.
  decorateShellAfterReady();
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

  const doHydratePty = () => {
    const baseUrl =
      typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
    if (!supportsFullAppShellRoutes(baseUrl)) return;
    client
      .getCodingAgentStatus()
      .then((s) => {
        if (s?.tasks)
          depsRef.current?.setPtySessions(mapServerTasksToSessions(s.tasks));
      })
      .catch((err: unknown) => {
        // error-policy:J4 PTY-session hydration decorates the coding-agent
        // panel; the panel's own load path surfaces hard failures. Logged so a
        // persistently broken orchestrator route is not invisible.
        logger.debug(
          { err },
          "[startup-phase-hydrate] coding-agent status hydrate failed",
        );
      });
  };
  // Recovery/refresh triggers (reconnect, visibility, periodic) only hit the
  // orchestrator/ACP routes once the agent runtime is running. Before that those
  // routes return 404 (runtime not yet wired) or 503 (services still finishing
  // start()); the browser logs every non-2xx fetch as a red console error
  // regardless of the .catch below, so gating the request — not catching it — is
  // what keeps the startup console clean.
  const hydratePty = () => {
    if (depsRef.current?.agentRunningRef.current) doHydratePty();
  };
  // Fire the initial (and post-restart) hydrate exactly once each time the agent
  // enters "running". Driven by the live status event below, with the poll
  // interval as a catch-all — no fixed delay guessing how long boot takes.
  let ptyRunning = false;
  const hydrateOnRunning = (running: boolean) => {
    if (running && !ptyRunning) {
      ptyRunning = true;
      doHydratePty();
    } else if (!running && ptyRunning) {
      ptyRunning = false; // re-arm so a restart re-hydrates once the agent is back
    }
  };
  // Re-poll only while sessions are active — avoids idle 5-second API calls. Also
  // the catch-all that hydrates once the agent is running if the live status
  // event was missed (e.g. status delivered via a non-WS source).
  ptyPollInterval = setInterval(() => {
    // Skip the 5s network poll while the tab is hidden — the WS status events
    // still hydrate on change; this interval is only the missed-event catch-all.
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const running = depsRef.current?.agentRunningRef.current ?? false;
    hydrateOnRunning(running);
    if (running && depsRef.current?.hasPtySessionsRef.current) doHydratePty();
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
          ptyRunning = false; // force re-hydrate now that the agent restarted
        }
        hydrateOnRunning(ns.state === "running");
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

  const unbindShellNavigateView = client.onWsEvent(
    SHELL_NAVIGATE_VIEW_WS_EVENT,
    (data: Record<string, unknown>) => {
      if (typeof window === "undefined") return;
      const payload = normalizeShellNavigateViewPayload(data);
      window.dispatchEvent(createNavigateViewEvent(payload));
    },
  );

  // Agent-driven text-inference switch (#12178). The server has already applied
  // the routing change over loopback before broadcasting; this handler surfaces
  // the user-facing confirmation. Download progress (local target, missing
  // bundle) continues to flow through the existing local-inference SSE stream +
  // home model-status hook — no re-fetch needed here.
  const unbindModelSwitch = client.onWsEvent(
    "shell:model-switch",
    (data: Record<string, unknown>) => {
      const target = data.target === "cloud" ? "cloud" : "local";
      const status =
        data.status === "downloading" ||
        data.status === "loading" ||
        data.status === "ready"
          ? data.status
          : "ready";
      const displayName =
        typeof data.displayName === "string" && data.displayName.length > 0
          ? data.displayName
          : typeof data.model === "string"
            ? data.model
            : target === "cloud"
              ? "Eliza Cloud"
              : "the on-device model";
      const notice =
        target === "cloud"
          ? `Switched to Eliza Cloud inference (${displayName}).`
          : status === "downloading"
            ? `Switching to on-device ${displayName} — downloading…`
            : status === "loading"
              ? `Switching to on-device ${displayName} — loading…`
              : `Switched to on-device ${displayName}.`;
      depsRef.current?.setActionNotice(
        notice,
        "success",
        undefined,
        false,
        status === "downloading" || status === "loading",
      );
    },
  );

  // Agent-driven runtime-profile switch (#12178). The server owns no profile
  // registry (profiles are client-persisted), so it broadcasts the request with
  // a `requestId`; the shell resolves the profile, applies it via the canonical
  // `switchRuntimeNonDestructive` (inheriting its remote-trust gate), and posts
  // the outcome back to the ORIGINATING agent's result endpoint. The result must
  // go to the origin base captured BEFORE the switch, since a successful switch
  // repoints the live client to a different backend.
  const unbindSwitchAgent = client.onWsEvent(
    "shell:switch-agent",
    (data: Record<string, unknown>) => {
      const requestId =
        typeof data.requestId === "string" ? data.requestId : null;
      const query = typeof data.profile === "string" ? data.profile : "";
      if (!requestId) return;

      const originBase =
        typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
      const reportResult = (body: {
        ok: boolean;
        profileId?: string;
        profileLabel?: string;
        reason?: string;
      }): void => {
        void fetch(`${originBase}/api/runtime/agent-switch/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, ...body }),
        }).catch(() => {
          // The switch already applied locally; a lost result callback only
          // means the agent's HTTP call times out (it degrades to "no-shell").
        });
      };

      const profile = resolveAgentProfileByQuery(
        query,
        loadAgentProfileRegistry(),
      );
      if (!profile) {
        reportResult({ ok: false, reason: "not-found" });
        return;
      }

      const result = switchRuntimeNonDestructive(profile.id);
      if (!result.ok) {
        reportResult({ ok: false, reason: result.reason });
        if (result.reason === "untrusted-remote") {
          depsRef.current?.setActionNotice(
            `Refused to switch to "${profile.label}" — untrusted remote address.`,
            "error",
          );
        }
        return;
      }
      reportResult({
        ok: true,
        profileId: result.profile.id,
        profileLabel: result.profile.label,
      });
      depsRef.current?.setActionNotice(
        `Switched the app to "${result.profile.label}".`,
        "success",
      );
    },
  );

  const unbindViewEvent = client.onWsEvent(
    "view:event",
    (data: Record<string, unknown>) => {
      const viewEventType =
        typeof data.viewEventType === "string" ? data.viewEventType : null;
      if (!viewEventType) return;
      const payload =
        data.payload !== null &&
        typeof data.payload === "object" &&
        !Array.isArray(data.payload)
          ? (data.payload as Record<string, unknown>)
          : {};
      emitViewEvent(viewEventType, payload, "agent");
    },
  );

  const unbindViewInteract = client.onWsEvent(
    "view:interact",
    (data: Record<string, unknown>) => {
      const viewId = typeof data.viewId === "string" ? data.viewId : null;
      const capability =
        typeof data.capability === "string" ? data.capability : null;
      const viewType =
        data.viewType === "gui" ||
        data.viewType === "tui" ||
        data.viewType === "xr"
          ? data.viewType
          : undefined;
      const requestId =
        typeof data.requestId === "string" ? data.requestId : null;
      if (!viewId || !capability || !requestId) return;
      const params =
        data.params !== null &&
        typeof data.params === "object" &&
        !Array.isArray(data.params)
          ? (data.params as Record<string, unknown>)
          : undefined;
      // Lazy-import to avoid pulling the registry into the startup bundle.
      import("../components/views/view-interact-registry")
        .then(({ dispatchViewInteract }) =>
          dispatchViewInteract(viewId, viewType, capability, params, requestId),
        )
        .catch(() => {
          client.sendWsMessage({
            type: "view:interact:result",
            requestId,
            success: false,
            error: "view-interact-registry not available",
          });
        });
    },
  );

  const unbindAgent = client.onWsEvent(
    "agent_event",
    (data: Record<string, unknown>) => {
      // The START/STOP_TRANSCRIPTION agent actions ride the "voice-control"
      // stream; re-dispatch them to the shell as a window event (the agent→shell
      // bridge) rather than treating them as autonomous trajectory events.
      if (data.stream === "voice-control") {
        const payload = data.payload as { command?: unknown } | undefined;
        if (payload?.command === "start" || payload?.command === "stop") {
          dispatchVoiceControl({ command: payload.command });
        }
        return;
      }
      const e = parseStreamEventEnvelopeEvent(data);
      if (e) {
        depsRef.current?.appendAutonomousEvent(e);
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
      if (
        msg.source &&
        msg.source !== MESSAGE_SOURCE_CLIENT_CHAT &&
        msg.role === "user"
      )
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
    unbindShellNavigateView();
    unbindModelSwitch();
    unbindSwitchAgent();
    unbindViewEvent();
    unbindViewInteract();
    unbindConvUp();
    unbindPty();
    if (ptyPollInterval) clearInterval(ptyPollInterval);
    if (handleVis) document.removeEventListener("visibilitychange", handleVis);
    client.disconnectWs();
  };
}
