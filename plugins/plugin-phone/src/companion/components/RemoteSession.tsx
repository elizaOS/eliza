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
} from "../services";

interface RemoteSessionProps {
  payload: PairingPayload;
  onExit(): void;
}

type ConnState = "connecting" | "open" | "closed" | "error";

const PULL_TO_REFRESH_THRESHOLD_PX = 80;
const PRIVATE_IPV6_PREFIXES = ["fe80:", "fec0:", "fc", "fd"] as const;

function parseIpv4Address(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (
    numbers.some((value) => Number.isNaN(value) || value < 0 || value > 255)
  ) {
    return null;
  }
  return numbers;
}

function parseMappedIpv6Address(mappedAddress: string): number[] | null {
  if (mappedAddress.includes(".")) {
    return parseIpv4Address(mappedAddress);
  }
  const parts = mappedAddress.split(":").filter(Boolean);
  if (parts.length === 1) {
    const value = Number.parseInt(parts[0], 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff_ffff) {
      return null;
    }
    return [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
  }
  if (parts.length !== 2) {
    return null;
  }
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if (
    Number.isNaN(high) ||
    Number.isNaN(low) ||
    high < 0 ||
    low < 0 ||
    high > 0xffff ||
    low > 0xffff
  ) {
    return null;
  }
  const value = (high << 16) + low;
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function isPrivateIpv4Address(parts: number[]): boolean {
  const [octet1, octet2] = parts;
  return (
    octet1 === 0 ||
    octet1 === 10 ||
    octet1 === 127 ||
    (octet1 === 169 && octet2 === 254) ||
    (octet1 === 172 && octet2 >= 16 && octet2 <= 31) ||
    (octet1 === 192 && octet2 === 168) ||
    (octet1 === 100 && octet2 >= 64 && octet2 <= 127)
  );
}

function isPrivateCompanionHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = parseMappedIpv6Address(normalized.slice("::ffff:".length));
    return mapped !== null && isPrivateIpv4Address(mapped);
  }
  if (normalized.includes(":")) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      PRIVATE_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    );
  }
  const ipv4 = parseIpv4Address(normalized);
  return ipv4 !== null && isPrivateIpv4Address(ipv4);
}

/**
 * Reject obviously unsafe companion ingress URLs before they are used as an
 * iframe `src` or WebSocket endpoint (phishing / token exfiltration).
 */
function assertSafeCompanionIngressUrl(ingressUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(ingressUrl);
  } catch {
    throw new Error("Companion ingress URL is not a valid absolute URL");
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "wss:" && protocol !== "ws:") {
    throw new Error("Companion ingress must use wss: or ws: (WebSocket) URL");
  }
  if (parsed.hostname.length === 0) {
    throw new Error("Companion ingress URL is missing a host");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Companion ingress URL must not embed credentials");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new Error("Companion ingress host is not allowed");
  }
  if (protocol === "ws:") {
    const allowPlaintextWs =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      isPrivateCompanionHost(host);
    if (!allowPlaintextWs) {
      throw new Error(
        "ws:// is only allowed on localhost or private networks; use wss:// for this host",
      );
    }
  }
  return parsed;
}

/**
 * Builds the noVNC viewer URL from a validated pairing ingress URL.
 * The ingress hosts noVNC at `/vnc` and the input WS at `/input`.
 * Uses the URL API so `/vnc` is joined on pathname, not appended after `?query`
 * (e.g. `wss://host/path/input?k=v` would otherwise yield `...?k=v/vnc`).
 */
function buildViewerUrl(ingressUrl: URL, payload: PairingPayload): string {
  const viewerUrl = new URL(ingressUrl.toString());
  viewerUrl.protocol = ingressUrl.protocol === "wss:" ? "https:" : "http:";
  viewerUrl.pathname = ingressUrl.pathname.replace(/\/input\/?$/, "") || "/";
  viewerUrl.pathname = `${viewerUrl.pathname.replace(/\/$/, "")}/vnc`;
  viewerUrl.searchParams.set("token", payload.sessionToken);
  viewerUrl.searchParams.set("agent", payload.agentId);
  viewerUrl.hash = "";
  return viewerUrl.toString();
}

function buildInputUrl(ingressUrl: URL): string {
  const inputUrl = new URL(ingressUrl.toString());
  if (!/\/input\/?$/.test(inputUrl.pathname)) {
    inputUrl.pathname = `${inputUrl.pathname.replace(/\/$/, "")}/input`;
  }
  inputUrl.hash = "";
  return inputUrl.toString();
}

export function RemoteSession({
  payload,
  onExit,
}: RemoteSessionProps): React.JSX.Element {
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [pullPx, setPullPx] = useState(0);
  const pullPxRef = useRef(0);
  const clientRef = useRef<SessionClient | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, TouchSample[]>>(new Map());
  const gestureStartRef = useRef<number | null>(null);
  // Scratch accumulator for multi-finger gestures. Not useState to avoid
  // re-renders on every pointer event.
  const completedPointersRef = useRef<TouchSample[][]>([]);

  const sessionEndpoints = useMemo(() => {
    try {
      const ingressUrl = assertSafeCompanionIngressUrl(payload.ingressUrl);
      return {
        ok: true as const,
        viewerUrl: buildViewerUrl(ingressUrl, payload),
        inputUrl: buildInputUrl(ingressUrl),
      };
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error("[RemoteSession] rejected ingress URL", { message });
      return { ok: false as const, error: message };
    }
  }, [payload]);

  // Connect/reconnect whenever the nonce changes.
  useEffect(() => {
    if (!sessionEndpoints.ok) {
      setConnState("error");
      return;
    }
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
    client.connect(sessionEndpoints.inputUrl, payload.sessionToken);

    return () => {
      offState();
      offError();
      client.close();
      clientRef.current = null;
    };
  }, [payload.agentId, payload.sessionToken, reconnectNonce, sessionEndpoints]);

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
          const next = Math.min(
            last.y - first.y,
            PULL_TO_REFRESH_THRESHOLD_PX * 2,
          );
          pullPxRef.current = next;
          setPullPx(next);
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
      const pull = pullPxRef.current;
      if (pull >= PULL_TO_REFRESH_THRESHOLD_PX) {
        pullPxRef.current = 0;
        setPullPx(0);
        reconnect();
        return;
      }
      pullPxRef.current = 0;
      setPullPx(0);

      const events = touchToInput({ pointers, ended: true });
      const client = clientRef.current;
      if (client === null) return;
      for (const ev of events) client.sendInput(ev);
    },
    [reconnect],
  );

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
        <span style={styles.status}>
          {!sessionEndpoints.ok
            ? sessionEndpoints.error
            : statusLabel(connState)}
        </span>
        <button
          type="button"
          onClick={reconnect}
          disabled={!sessionEndpoints.ok}
          style={styles.reconnect}
        >
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
          src={sessionEndpoints.ok ? sessionEndpoints.viewerUrl : "about:blank"}
          style={styles.iframe}
          allow="clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
        <div
          ref={surfaceRef}
          style={{
            ...styles.inputSurface,
            pointerEvents: sessionEndpoints.ok ? "auto" : "none",
          }}
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
