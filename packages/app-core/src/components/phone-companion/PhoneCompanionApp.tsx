import type React from "react";
import { useEffect, useState } from "react";
import {
  agentUrl as configuredAgentUrl,
  apnsEnabled,
  logger,
  MiladyIntent,
  type PairingPayload,
  type RegisterPushHandle,
  registerPush,
  useNavigation,
  type ViewName,
} from "../../services/phone-companion";
import { Chat } from "./Chat";
import { Pairing } from "./Pairing";
import { RemoteSession } from "./RemoteSession";

/**
 * The phone-companion surface — three-view Capacitor app that pairs with a
 * Milady desktop agent (QR handshake), mirrors chat, and serves as the
 * remote-session viewer for the paired Mac. Formerly shipped as
 * `apps/app-ios-companion`; now rendered inside the main iOS bundle.
 */
export function PhoneCompanionApp(): React.JSX.Element {
  const nav = useNavigation();
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  const [pairingPayload, setPairingPayload] = useState<PairingPayload | null>(
    null,
  );

  useEffect(() => {
    logger.info("[PhoneCompanionApp] boot", {
      apnsEnabled: apnsEnabled(),
      hasConfiguredAgentUrl: configuredAgentUrl() !== null,
    });
    MiladyIntent.getPairingStatus().then((status) => {
      if (status.paired && status.agentUrl !== null) {
        setAgentUrl(status.agentUrl);
      }
    });
  }, []);

  useEffect(() => {
    if (!apnsEnabled()) return;
    let handle: RegisterPushHandle | null = null;
    registerPush({
      onIntent: (intent) => {
        if (intent.kind === "session-start") {
          logger.info("[PhoneCompanionApp] session.start intent -> RemoteSession", {
            agentId: intent.payload.agentId,
          });
          setPairingPayload(intent.payload);
          setAgentUrl(intent.payload.ingressUrl);
          nav.push("remote-session");
        }
      },
      onError: (err) => {
        logger.warn("[PhoneCompanionApp] push registration error", {
          message: err.message,
        });
      },
    }).then((h) => {
      handle = h;
    });
    return () => {
      handle?.unregister();
    };
  }, [nav]);

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
