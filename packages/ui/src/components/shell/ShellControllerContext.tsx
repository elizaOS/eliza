/**
 * Provides the one shell chat/voice controller to every overlay, launcher
 * surface, and conversation-nav consumer — and, on the multi-window desktop,
 * guarantees a SINGLE engine across windows (#16442).
 *
 * The native authority assigns each window an owner or follower role. The OWNER
 * mounts the real `useShellController` engine (the sole microphone/audio owner),
 * publishes its state, and applies followers' commands. A FOLLOWER never mounts
 * the engine: it renders the owner's published snapshot and forwards typed
 * commands. Owner and follower are distinct components at this position, so a
 * genuine handoff (owner window closes) tears the engine down in the old owner
 * and stands it up in the promoted window — never two mics at once. With no
 * cross-window transport (web, mobile, single-window) the window is a lone owner
 * and this behaves exactly as it did before.
 */
import * as React from "react";

import { useIsAuthenticated } from "../../hooks/useAuthStatus";
import { IntentDedupeStore } from "../../os-intent/dedupe";
import {
  dispatchOsIntentComposerPrefill,
  loadOsIntentDedupeSnapshot,
  saveOsIntentDedupeSnapshot,
} from "../../os-intent/host";
import { routeIntent } from "../../os-intent/router";
import { useAppSelectorShallow } from "../../state/app-store";
import { loadOsIntentAutoStartConsent } from "../../state/persistence";
import { ShellControllerContext } from "./ShellControllerContext.hooks";
import { applyShellControllerCommand } from "./shell-controller-sync/apply-command";
import { buildFollowerController } from "./shell-controller-sync/follower-controller";
import type {
  ShellAuthorityDelivery,
  ShellControllerCommand,
} from "./shell-controller-sync/protocol";
import {
  deriveShellControllerSnapshot,
  snapshotsEqual,
} from "./shell-controller-sync/snapshot";
import { useOsIntentRouting } from "./shell-controller-sync/useOsIntentRouting";
import {
  type ShellControllerSync,
  useShellControllerSync,
} from "./shell-controller-sync/useShellControllerSync";
import { type ShellController, useShellController } from "./useShellController";

/**
 * Owner path: run the real engine, publish its snapshot to followers (coalescing
 * the many per-token updates a streaming reply emits), and apply followers'
 * commands against it. Provides the live controller unchanged.
 */
export function OwnerShellControllerProvider({
  sync,
  children,
}: {
  sync: ShellControllerSync;
  children: React.ReactNode;
}): React.JSX.Element {
  const controller = useShellController();
  const authenticated = useIsAuthenticated();
  const { setActionNotice } = useAppSelectorShallow((state) => ({
    setActionNotice: state.setActionNotice,
  }));
  const controllerRef = React.useRef(controller);
  controllerRef.current = controller;
  const localDictationSinkRef =
    React.useRef<Parameters<ShellController["setDictationSink"]>[0]>(null);
  const localTranscriptSinkRef =
    React.useRef<Parameters<ShellController["setTranscriptSessionSink"]>[0]>(
      null,
    );
  const remoteDictationTargetRef = React.useRef<string | null>(null);
  const remoteTranscriptTargetRef = React.useRef<string | null>(null);
  const intentDedupeRef = React.useRef<IntentDedupeStore | null>(null);
  if (intentDedupeRef.current === null) {
    intentDedupeRef.current = new IntentDedupeStore({
      seed: loadOsIntentDedupeSnapshot(),
    });
  }
  const pendingIntentIdsRef = React.useRef(new Set<string>());

  React.useLayoutEffect(() => {
    controller.setDictationSink((text) => {
      const target = remoteDictationTargetRef.current;
      if (!target) {
        localDictationSinkRef.current?.(text);
        return;
      }
      remoteDictationTargetRef.current = null;
      void sync
        .deliver(target, { kind: "dictation", text })
        .catch((error: unknown) =>
          sync.reportError("shell dictation delivery failed", error),
        );
    });
    controller.setTranscriptSessionSink((segments, startedAtMs, audioWav) => {
      const target = remoteTranscriptTargetRef.current;
      if (!target) {
        localTranscriptSinkRef.current?.(segments, startedAtMs, audioWav);
        return;
      }
      remoteTranscriptTargetRef.current = null;
      void sync
        .deliver(target, {
          kind: "transcript-session",
          segments,
          startedAtMs,
          audioWav,
        })
        .catch((error: unknown) =>
          sync.reportError("shell transcript delivery failed", error),
        );
    });
    return () => {
      controller.setDictationSink(null);
      controller.setTranscriptSessionSink(null);
    };
  }, [
    controller.setDictationSink,
    controller.setTranscriptSessionSink,
    sync.deliver,
    sync.reportError,
  ]);

  const ownerController = React.useMemo<ShellController>(
    () => ({
      ...controller,
      startRecording: (intent) => {
        remoteDictationTargetRef.current = null;
        if (intent === "transcription")
          remoteTranscriptTargetRef.current = null;
        controller.startRecording(intent);
      },
      toggleTranscriptionMode: () => {
        remoteTranscriptTargetRef.current = null;
        return controller.toggleTranscriptionMode();
      },
      stopTranscriptionAndMic: () => {
        remoteTranscriptTargetRef.current = null;
        return controller.stopTranscriptionAndMic();
      },
      setDictationSink: (sink) => {
        localDictationSinkRef.current = sink;
      },
      setTranscriptSessionSink: (sink) => {
        localTranscriptSinkRef.current = sink;
      },
    }),
    [controller],
  );

  const deliverComposerPrefill = React.useCallback(
    async (targetEndpointId: string, text: string): Promise<void> => {
      if (
        targetEndpointId === "local" ||
        targetEndpointId === sync.endpointId
      ) {
        dispatchOsIntentComposerPrefill(text);
        return;
      }
      await sync.deliver(targetEndpointId, {
        kind: "composer-prefill",
        text,
      });
    },
    [sync.deliver, sync.endpointId],
  );

  const routeOsIntent = React.useCallback(
    async (
      command: Extract<ShellControllerCommand, { kind: "routeOsIntent" }>,
      fromEndpointId: string,
    ): Promise<void> => {
      const { intent } = command;
      const pending = pendingIntentIdsRef.current;
      if (pending.has(intent.intentId)) return;
      pending.add(intent.intentId);
      try {
        const consent = loadOsIntentAutoStartConsent();
        const hasBrowserCapture =
          typeof navigator !== "undefined" &&
          typeof navigator.mediaDevices?.getUserMedia === "function";
        const hasNativeCapture =
          typeof globalThis !== "undefined" &&
          ("Capacitor" in globalThis ||
            (typeof window !== "undefined" &&
              "__ELIZA_ELECTROBUN_RPC__" in window));
        const sandboxed =
          typeof window !== "undefined" && window.top !== window.self;
        const now = Date.now();
        const outcome = routeIntent(
          intent,
          {
            now,
            auth: authenticated ? "authenticated" : "unauthenticated",
            device: {
              locked: false,
              foreground:
                typeof document === "undefined" ||
                document.visibilityState === "visible",
            },
            capabilities: {
              voiceCapture: hasBrowserCapture || hasNativeCapture,
              sandboxed,
              microphone: controllerRef.current.micPermission,
            },
            consent: {
              autoStartVoice: consent.voice,
              autoStartTranscription: consent.transcription,
            },
            maxIntentAgeMs: 5 * 60 * 1_000,
          },
          intentDedupeRef.current as IntentDedupeStore,
          { record: false },
        );

        if (outcome.status === "duplicate") return;
        if (outcome.status === "stale") {
          setActionNotice?.(
            "This shortcut request expired. Try it again.",
            "error",
            4_000,
          );
          return;
        }
        if (outcome.status === "consent-required") {
          setActionNotice?.(
            "Microphone auto-start is off. Enable it in Settings → Voice, then try again.",
            "error",
            6_000,
          );
          return;
        }
        if (outcome.status === "degraded") {
          setActionNotice?.(
            outcome.reason === "sandboxed"
              ? "Voice shortcuts aren't available in this embedded view."
              : "Voice capture isn't supported on this device.",
            "error",
            5_000,
          );
          return;
        }
        if (outcome.status === "blocked") {
          const message =
            outcome.reason === "microphone-denied"
              ? "Microphone access is off. Enable it in system settings, then try again."
              : outcome.reason === "backgrounded"
                ? "Bring Eliza to the foreground, then try the shortcut again."
                : outcome.reason === "locked"
                  ? "Unlock this device, then try the shortcut again."
                  : "Sign in again, then retry this shortcut.";
          setActionNotice?.(message, "error", 5_000);
          return;
        }

        if (
          command.deliveryPolicy === "review-send" &&
          intent.type === "send"
        ) {
          await applyShellControllerCommand(controllerRef.current, {
            kind: "open",
          });
          await deliverComposerPrefill(fromEndpointId, intent.text);
        } else {
          for (const routedCommand of outcome.commands) {
            await applyShellControllerCommand(
              controllerRef.current,
              routedCommand,
            );
          }
        }
        intentDedupeRef.current?.record(intent.intentId, now);
        const persisted = saveOsIntentDedupeSnapshot(
          intentDedupeRef.current?.snapshot(now) ?? [],
        );
        if (!persisted) {
          setActionNotice?.(
            "This shortcut ran, but duplicate protection couldn't be saved for app restart.",
            "error",
            6_000,
          );
        }
      } finally {
        pending.delete(intent.intentId);
      }
    },
    [authenticated, deliverComposerPrefill, setActionNotice],
  );

  // Register the command sink once; the closure reads the live controller via a
  // ref so a follower's command always hits the current engine.
  React.useLayoutEffect(() => {
    sync.setCommandHandler(async (command, fromEndpointId) => {
      if (command.kind === "routeOsIntent") {
        await routeOsIntent(command, fromEndpointId);
        return;
      }
      const priorDictationTarget = remoteDictationTargetRef.current;
      const priorTranscriptTarget = remoteTranscriptTargetRef.current;
      if (command.kind === "startRecording" && command.intent === "dictate") {
        remoteDictationTargetRef.current = fromEndpointId;
      }
      if (
        (command.kind === "startRecording" &&
          command.intent === "transcription") ||
        command.kind === "toggleTranscriptionMode" ||
        command.kind === "stopTranscriptionAndMic"
      ) {
        remoteTranscriptTargetRef.current = fromEndpointId;
      }
      try {
        await applyShellControllerCommand(controllerRef.current, command);
      } catch (error) {
        remoteDictationTargetRef.current = priorDictationTarget;
        remoteTranscriptTargetRef.current = priorTranscriptTarget;
        throw error;
      }
    });
    return () => sync.setCommandHandler(null);
  }, [routeOsIntent, sync.setCommandHandler]);

  // Publish on any engine change; the equality guard keeps an unchanged tick
  // (and an unchanged streamed token) off the wire.
  const lastPublishedRef = React.useRef<ReturnType<
    typeof deriveShellControllerSnapshot
  > | null>(null);
  React.useEffect(() => {
    const snapshot = deriveShellControllerSnapshot(controller);
    if (
      lastPublishedRef.current &&
      snapshotsEqual(lastPublishedRef.current, snapshot)
    ) {
      return;
    }
    lastPublishedRef.current = snapshot;
    sync.publishSnapshot(snapshot);
  });

  return (
    <ShellControllerContext.Provider value={ownerController}>
      {children}
    </ShellControllerContext.Provider>
  );
}

/**
 * Follower path: render the owner's snapshot and forward commands. Never mounts
 * the engine, so it can neither open a mic nor start a second chat session. A
 * null controller (no snapshot yet, or a version-mismatch/disconnected owner)
 * degrades the overlay to hidden rather than rendering stale state.
 */
export function FollowerShellControllerProvider({
  sync,
  onCommandError,
  children,
}: {
  sync: ShellControllerSync;
  onCommandError: (command: ShellControllerCommand, error: unknown) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const dictationSinkRef =
    React.useRef<Parameters<ShellController["setDictationSink"]>[0]>(null);
  const transcriptSinkRef =
    React.useRef<Parameters<ShellController["setTranscriptSessionSink"]>[0]>(
      null,
    );
  const setDictationSink = React.useCallback<
    ShellController["setDictationSink"]
  >((sink) => {
    dictationSinkRef.current = sink;
  }, []);
  const setTranscriptSessionSink = React.useCallback<
    ShellController["setTranscriptSessionSink"]
  >((sink) => {
    transcriptSinkRef.current = sink;
  }, []);
  React.useLayoutEffect(() => {
    sync.setDeliveryHandler((delivery: ShellAuthorityDelivery) => {
      if (delivery.kind === "dictation") {
        dictationSinkRef.current?.(delivery.text);
      } else if (delivery.kind === "composer-prefill") {
        dispatchOsIntentComposerPrefill(delivery.text);
      } else {
        transcriptSinkRef.current?.(
          delivery.segments,
          delivery.startedAtMs,
          delivery.audioWav,
        );
      }
    });
    return () => sync.setDeliveryHandler(null);
  }, [sync.setDeliveryHandler]);

  const controller = React.useMemo(() => {
    if (!sync.snapshot) return null;
    return buildFollowerController({
      snapshot: sync.snapshot,
      dispatch: sync.dispatch,
      onCommandError,
      setDictationSink,
      setTranscriptSessionSink,
    });
  }, [
    sync.snapshot,
    sync.dispatch,
    onCommandError,
    setDictationSink,
    setTranscriptSessionSink,
  ]);

  return (
    <ShellControllerContext.Provider value={controller}>
      {children}
    </ShellControllerContext.Provider>
  );
}

/**
 * Provides a single shell controller to the shell pill / overlay. On the desktop
 * it elects one engine owner across windows; everywhere else it is the lone
 * owner. See the module header for the ownership + handoff contract.
 */
export function ShellControllerProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { setActionNotice } = useAppSelectorShallow((s) => ({
    setActionNotice: s.setActionNotice,
  }));
  const sync = useShellControllerSync();
  useOsIntentRouting(sync);

  const onCommandError = React.useCallback(
    (_command: ShellControllerCommand, _error: unknown) => {
      setActionNotice?.(
        "Couldn't reach the assistant. Bring its window to the front and try again.",
        "error",
        4000,
      );
    },
    [setActionNotice],
  );

  if (sync.role === "owner") {
    return (
      <OwnerShellControllerProvider sync={sync}>
        {children}
      </OwnerShellControllerProvider>
    );
  }
  return (
    <FollowerShellControllerProvider
      sync={sync}
      onCommandError={onCommandError}
    >
      {children}
    </FollowerShellControllerProvider>
  );
}
