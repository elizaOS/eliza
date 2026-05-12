import { Capacitor } from "@capacitor/core";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  apnsEnabled,
  agentUrl as configuredAgentUrl,
  ElizaIntent,
  logger,
  type PairingPayload,
  type RegisterPushHandle,
  registerPush,
  useNavigation,
  type ViewName,
} from "../services";
import { Chat } from "./Chat";
import { Pairing } from "./Pairing";
import { RemoteSession } from "./RemoteSession";

/**
 * The phone-companion surface — three-view Capacitor app that pairs with a
 * Eliza desktop agent (QR handshake), mirrors chat, and serves as the
 * remote-session viewer for the paired Mac. Formerly shipped as a standalone
 * top-level app project; now rendered inside the main iOS bundle.
 */
export function PhoneCompanionApp(): React.JSX.Element {
  const nav = useNavigation();
  const pushRef = useRef(nav.push);
  pushRef.current = nav.push;
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  const [pairingPayload, setPairingPayload] = useState<PairingPayload | null>(
    null,
  );

  const persistPairingToNative = useCallback(
    async (payload: PairingPayload) => {
      if (!Capacitor.isNativePlatform()) return;
      try {
        await ElizaIntent.setPairingStatus({
          deviceId: payload.agentId,
          agentUrl: payload.ingressUrl,
        });
      } catch (err) {
        logger.warn("[PhoneCompanionApp] setPairingStatus failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [],
  );

  useEffect(() => {
    logger.info("[PhoneCompanionApp] boot", {
      apnsEnabled: apnsEnabled(),
      hasConfiguredAgentUrl: configuredAgentUrl() !== null,
    });
    ElizaIntent.getPairingStatus().then((status) => {
      if (status.paired && status.agentUrl !== null) {
        setAgentUrl(status.agentUrl);
      }
    });
  }, []);

  useEffect(() => {
    if (!apnsEnabled()) return;
    let disposed = false;
    let handle: RegisterPushHandle | null = null;
    void registerPush({
      onIntent: (intent) => {
        if (intent.kind === "session-start") {
          logger.info(
            "[PhoneCompanionApp] session.start intent -> RemoteSession",
            {
              agentId: intent.payload.agentId,
            },
          );
          void persistPairingToNative(intent.payload);
          setPairingPayload(intent.payload);
          setAgentUrl(intent.payload.ingressUrl);
          pushRef.current("remote-session");
        }
      },
      onError: (err) => {
        logger.warn("[PhoneCompanionApp] push registration error", {
          message: err.message,
        });
      },
    }).then((h) => {
      if (disposed) {
        void h.unregister();
        return;
      }
      handle = h;
    });
    return () => {
      disposed = true;
      void handle?.unregister();
    };
  }, [persistPairingToNative]);

  if (!nav.ready) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  return renderView(nav.view, {
    agentUrl,
    pairingPayload,
    onPushPairing: () => nav.push("pairing"),
    onPushRemoteSession: () => nav.push("remote-session"),
    onBackToChat: () => nav.pop("chat"),
    onPaired: (payload: PairingPayload) => {
      void persistPairingToNative(payload);
      setPairingPayload(payload);
      setAgentUrl(payload.ingressUrl);
      nav.push("remote-session");
    },
  });
}

interface ViewHandlers {
  agentUrl: string | null;
  pairingPayload: PairingPayload | null;
  onPushPairing(): void;
  onPushRemoteSession(): void;
  onBackToChat(): void;
  onPaired(payload: PairingPayload): void;
}

function renderView(view: ViewName, h: ViewHandlers): React.JSX.Element {
  if (view === "pairing") {
    return <Pairing onPaired={h.onPaired} onBack={h.onBackToChat} />;
  }
  if (view === "remote-session") {
    if (h.pairingPayload === null) {
      return (
        <Chat
          pairedAgentUrl={h.agentUrl}
          onOpenPairing={h.onPushPairing}
          onOpenRemoteSession={h.onPushRemoteSession}
          remoteSessionAvailable={false}
        />
      );
    }
    return <RemoteSession payload={h.pairingPayload} onExit={h.onBackToChat} />;
  }
  return (
    <Chat
      pairedAgentUrl={h.agentUrl}
      onOpenPairing={h.onPushPairing}
      onOpenRemoteSession={h.onPushRemoteSession}
      remoteSessionAvailable={h.pairingPayload !== null}
    />
  );
}
