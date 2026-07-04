/**
 * Embeds an app-run viewer iframe and coordinates the origin-pinned
 * postMessage authentication handshake for hosted app surfaces.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppViewerAuthMessage } from "../../api/client-types-cloud";
import {
  resolveEmbeddedViewerUrl,
  resolvePostMessageTargetOrigin,
  resolveViewerReadyEventType,
} from "./viewer-auth";

const DEFAULT_SANDBOX = "allow-scripts allow-same-origin allow-popups";

export type EmbeddedAppViewerStatus = "loading" | "ready" | "authenticated";

export interface EmbeddedAppViewerProps {
  /** The run's `viewer.url` — an absolute http(s) URL or an `/api/...` path. */
  viewerUrl: string;
  /**
   * The run's `viewer.authMessage` (e.g. the FEED_AUTH payload carrying the
   * agent session token). When present, the viewer performs the postMessage
   * auth handshake: it waits for the embedded app's `*_READY` event, then posts
   * the auth payload back so the app loads authenticated as the agent.
   */
  authMessage?: AppViewerAuthMessage | null;
  /** iframe `sandbox` attribute. Defaults to the standard app-viewer sandbox. */
  sandbox?: string;
  /** Accessible iframe title. */
  title: string;
  className?: string;
  /** Notified when the auth handshake completes. */
  onStatusChange?: (status: EmbeddedAppViewerStatus) => void;
}

/**
 * Embeds a running app's web client in an iframe and (when the run supplies a
 * postMessage auth payload) runs the `*_READY` → auth handshake so the embedded
 * app loads authenticated — e.g. the full Feed web app signed in as the agent.
 *
 * Extracted from {@link FullscreenView} so any view or embedded app can
 * reuse the exact same secure, origin-pinned handshake. The auth payload carries
 * a session/agent token, so it is only ever posted to a concrete, verified
 * http(s) `targetOrigin`; an unparseable/non-http(s)/opaque viewer origin fails
 * closed (no payload is sent and inbound messages are ignored).
 */
export function EmbeddedAppViewer({
  viewerUrl,
  authMessage,
  sandbox,
  title,
  className,
  onStatusChange,
}: EmbeddedAppViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const authSentRef = useRef(false);
  const [status, setStatus] = useState<EmbeddedAppViewerStatus>("loading");

  const resolvedUrl = useMemo(
    () => resolveEmbeddedViewerUrl(viewerUrl),
    [viewerUrl],
  );
  const targetOrigin = useMemo(
    () => resolvePostMessageTargetOrigin(viewerUrl),
    [viewerUrl],
  );

  // Re-arm the handshake whenever the run's viewer URL or auth payload changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm on identity change of the auth payload.
  useEffect(() => {
    authSentRef.current = false;
    setStatus("loading");
    onStatusChange?.("loading");
  }, [resolvedUrl, authMessage, onStatusChange]);

  useEffect(() => {
    if (!authMessage) return;
    const expectedReadyType = resolveViewerReadyEventType(authMessage);
    if (!expectedReadyType) return;
    // Fail closed: without a concrete http(s) origin we can neither verify the
    // sender nor safely target the token-bearing auth payload, so never send it.
    if (!targetOrigin) return;

    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (authSentRef.current) return;
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;
      if (event.origin !== targetOrigin) return;
      if (event.data?.type !== expectedReadyType) return;
      iframeWindow.postMessage(authMessage, targetOrigin);
      authSentRef.current = true;
      setStatus("authenticated");
      onStatusChange?.("authenticated");
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [authMessage, targetOrigin, onStatusChange]);

  return (
    <iframe
      ref={iframeRef}
      src={resolvedUrl}
      sandbox={sandbox ?? DEFAULT_SANDBOX}
      allow="fullscreen *"
      allowFullScreen
      data-testid="embedded-app-viewer-iframe"
      data-viewer-status={status}
      className={className ?? "h-full w-full border-none"}
      title={title}
      onLoad={() => {
        if (status === "loading") {
          setStatus("ready");
          onStatusChange?.("ready");
        }
      }}
    />
  );
}
