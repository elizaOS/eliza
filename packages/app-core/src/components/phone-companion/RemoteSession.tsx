import React, {
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  logger,
  type PairingPayload,
  SessionClient,
  type TouchSample,
  touchToInput,
} from "../../services/phone-companion";

interface RemoteSessionProps {
  payload: PairingPayload;
  onExit(): void;
}

type ConnState = "connecting" | "open" | "closed" | "error";

const PULL_TO_REFRESH_THRESHOLD_PX = 80;

/**
 * Builds the noVNC viewer URL from a pairing payload.
 * The ingress hosts noVNC at `/vnc` and the input WS at `/input`.
 */
function buildViewerUrl(payload: PairingPayload): string {
  const baseUrl = payload.ingressUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/input\/?$/, "");
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}/vnc${separator}token=${encodeURIComponent(
    payload.sessionToken,
  )}&agent=${encodeURIComponent(payload.agentId)}`;
}

function buildInputUrl(payload: PairingPayload): string {
  if (/\/input\/?$/.test(payload.ingressUrl)) return payload.ingressUrl;
  return payload.ingressUrl.replace(/\/?$/, "/input");
}

export function RemoteSession({
  payload,
  onExit,
}: RemoteSessionProps): React.JSX.Element {
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [pullPx, setPullPx] = useState(0);
  const clientRef = useRef<SessionClient | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, TouchSample[]>>(new Map());
  const gestureStartRef = useRef<number | null>(null);

  const viewerUrl = useMemo(() => buildViewerUrl(payload), [payload]);
  const inputUrl = useMemo(() => buildInputUrl(payload), [payload]);

  // Connect/reconnect whenever the nonce changes.
  useEffect(() => {
    const client = new SessionClient();
    clientRef.current = client;

    const offState = client.on("state", (state) => {
      if (state === "connecting") setConnState("connecting");
      else if (state === "open") setConnState("open");
      else if (state === "closed") setConnState("closed");
    });
    const offError = client.on("error", () => {
      setConnState("error");
    });

    logger.info("[RemoteSession] connecting", {
      agentId: payload.agentId,
      attempt: reconnectNonce,
    });
    client.connect(inputUrl, payload.sessionToken);

    return () => {
      offState();
      offError();
      client.close();
      clientRef.current = null;
    };
  }, [inputUrl, payload.agentId, payload.sessionToken, reconnectNonce]);

  const reconnect = useCallback(() => {
    logger.info("[RemoteSession] reconnect requested", {});
    setReconnectNonce((n) => n + 1);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch") return;
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const sample: TouchSample = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        t: event.timeStamp,
        pointerId: event.pointerId,
      };
      pointersRef.current.set(event.pointerId, [sample]);
      if (gestureStartRef.current === null) {
        gestureStartRef.current = event.timeStamp;
      }
      (event.target as Element).setPointerCapture?.(event.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch") return;
      const samples = pointersRef.current.get(event.pointerId);
      if (samples === undefined) return;
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      samples.push({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        t: event.timeStamp,
        pointerId: event.pointerId,
      });
      // Pull-to-refresh indicator: single active pointer, near the top,
      // moving downward.
      if (pointersRef.current.size === 1 && samples.length > 1) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        if (first.y < 40 && last.y > first.y) {
          setPullPx(
            Math.min(last.y - first.y, PULL_TO_REFRESH_THRESHOLD_PX * 2),
          );
        }
      }
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch") return;
      const samples = pointersRef.current.get(event.pointerId);
      if (samples === undefined) return;

      // Wait until all fingers are lifted before translating.
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size > 0) {
        // Save the completed pointer on a scratch map keyed back onto itself.
        // We re-add a zero-length marker so the final gesture can still see
        // the pointer. Simpler: accumulate into gestureEndedPointers below.
        completedPointersRef.current.push(samples);
        return;
      }

      completedPointersRef.current.push(samples);
      const pointers = completedPointersRef.current.slice();
      completedPointersRef.current = [];
      gestureStartRef.current = null;

      // Pull-to-refresh: if user pulled far enough, reconnect rather than
      // emit a drag.
      if (pullPx >= PULL_TO_REFRESH_THRESHOLD_PX) {
        setPullPx(0);
        reconnect();
        return;
      }
      setPullPx(0);

      const events = touchToInput({ pointers, ended: true });
      const client = clientRef.current;
      if (client === null) return;
      for (const ev of events) client.sendInput(ev);
    },
    [pullPx, reconnect],
  );

  // Scratch accumulator for multi-finger gestures. Not useState to avoid
  // re-renders on every pointer event.
  const completedPointersRef = useRef<TouchSample[][]>([]);

  // Block default iOS touch behaviours on the input surface.
  const onTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  return (
    <main style={styles.root}>
      <header style={styles.header}>
        <button type="button" onClick={onExit} style={styles.back}>
          Exit
        </button>
        <span style={styles.status}>{statusLabel(connState)}</span>
        <button type="button" onClick={reconnect} style={styles.reconnect}>
          Reconnect
        </button>
      </header>

      {pullPx > 0 ? (
        <div
          style={{
            ...styles.pull,
            height: pullPx,
            opacity: Math.min(pullPx / PULL_TO_REFRESH_THRESHOLD_PX, 1),
          }}
        >
          {pullPx >= PULL_TO_REFRESH_THRESHOLD_PX
            ? "Release to reconnect"
            : "Pull to reconnect"}
        </div>
      ) : null}

      <div style={styles.viewerShell}>
        <iframe
          title="Remote desktop"
          src={viewerUrl}
          style={styles.iframe}
          allow="clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
        <div
          ref={surfaceRef}
          style={styles.inputSurface}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onTouchStart={onTouchStart}
        />
      </div>
    </main>
  );
}

function statusLabel(state: ConnState): string {
  if (state === "connecting") return "Connecting...";
  if (state === "open") return "Connected";
  if (state === "error") return "Error";
  return "Disconnected";
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#000",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    background: "#0a0a0a",
    borderBottom: "1px solid #1f2937",
  },
  back: {
    background: "transparent",
    border: "none",
    color: "#93c5fd",
    fontSize: 16,
  },
  status: { fontSize: 14, opacity: 0.8 },
  reconnect: {
    background: "transparent",
    border: "1px solid #374151",
    color: "#e5e7eb",
    borderRadius: 999,
    padding: "4px 10px",
    fontSize: 13,
  },
  pull: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#9ca3af",
    fontSize: 13,
    transition: "height 50ms linear",
  },
  viewerShell: { position: "relative", flex: 1 },
  iframe: {
    width: "100%",
    height: "100%",
    border: "none",
    background: "#000",
  },
  inputSurface: {
    position: "absolute",
    inset: 0,
    touchAction: "none",
    background: "transparent",
  },
};
