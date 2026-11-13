/**
 * Provides the one shell chat/voice controller to every overlay, launcher
 * surface, and conversation-nav consumer, and routes deep-linked OS intents
 * (`#os-intent=`) into it.
 */

import type { OsIntent } from "@elizaos/contracts";
import { IntentDedupeStore, routeIntent } from "@elizaos/host/protocol";
import * as React from "react";
import { useIsAuthenticated } from "../../hooks/useAuthStatus";
import {
  dispatchOsIntentComposerPrefill,
  loadOsIntentDedupeSnapshot,
  saveOsIntentDedupeSnapshot,
} from "../../platform/os-intent";
import { useAppSelectorShallow } from "../../state/app-store";
import { loadOsIntentAutoStartConsent } from "../../state/persistence";
import { ShellControllerContext } from "./ShellControllerContext.hooks";
import { applyShellControllerCommand } from "./shell-controller-sync/apply-command";
import { useOsIntentRouting } from "./shell-controller-sync/useOsIntentRouting";
import { useShellController } from "./useShellController";

export function ShellControllerProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const controller = useShellController();
  const authenticated = useIsAuthenticated();
  const { setActionNotice } = useAppSelectorShallow((state) => ({
    setActionNotice: state.setActionNotice,
  }));
  const controllerRef = React.useRef(controller);
  controllerRef.current = controller;
  const intentDedupeRef = React.useRef<IntentDedupeStore | null>(null);
  if (intentDedupeRef.current === null) {
    intentDedupeRef.current = new IntentDedupeStore({
      seed: loadOsIntentDedupeSnapshot(),
    });
  }
  const pendingIntentIdsRef = React.useRef(new Set<string>());

  const routeOsIntent = React.useCallback(
    async (intent: OsIntent): Promise<void> => {
      const pending = pendingIntentIdsRef.current;
      if (pending.has(intent.intentId)) return;
      pending.add(intent.intentId);
      try {
        const consent = loadOsIntentAutoStartConsent();
        const hasBrowserCapture =
          typeof navigator !== "undefined" &&
          typeof navigator.mediaDevices?.getUserMedia === "function";
        const hasNativeCapture =
          typeof globalThis !== "undefined" && "Capacitor" in globalThis;
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

        // A deep-linked send is reviewed in the composer, never sent unseen.
        if (intent.type === "send") {
          await applyShellControllerCommand(controllerRef.current, {
            kind: "open",
          });
          dispatchOsIntentComposerPrefill(intent.text);
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
    [authenticated, setActionNotice],
  );

  useOsIntentRouting(routeOsIntent);

  return (
    <ShellControllerContext.Provider value={controller}>
      {children}
    </ShellControllerContext.Provider>
  );
}
