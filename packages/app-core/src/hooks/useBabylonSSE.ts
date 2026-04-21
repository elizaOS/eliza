/**
 * SSE hook for real-time Babylon agent activity streaming.
 * Falls back to polling if SSE connection fails.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BabylonActivityItem } from "../api/client-types-babylon";

const MAX_ACTIVITY_ITEMS = 100;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

export interface BabylonSSEState {
  connected: boolean;
  items: BabylonActivityItem[];
}

export function useBabylonSSE(
  apiBase: string,
  enabled: boolean,
): BabylonSSEState {
  const [connected, setConnected] = useState(false);
  const [items, setItems] = useState<BabylonActivityItem[]>([]);
  const reconnectAttemptRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const addItem = useCallback((item: BabylonActivityItem) => {
    setItems((prev) => {
      const next = [item, ...prev];
      return next.length > MAX_ACTIVITY_ITEMS
        ? next.slice(0, MAX_ACTIVITY_ITEMS)
        : next;
    });
  }, []);

  useEffect(() => {
    if (!enabled || !apiBase) return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;

      const url = `${apiBase}/api/apps/babylon/sse`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        reconnectAttemptRef.current = 0;
      };

      es.onmessage = (event) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(event.data) as {
            type?: string;
            data?: BabylonActivityItem;
          };
          if (data.data && data.type) {
            const item: BabylonActivityItem = {
              ...data.data,
              type: (data.data.type ??
                data.type) as BabylonActivityItem["type"],
              timestamp: data.data.timestamp ?? new Date().toISOString(),
            };
            addItem(item);
          }
        } catch {
          // Ignore unparseable events (heartbeats, etc.)
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        es.close();
        eventSourceRef.current = null;
        setConnected(false);

        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(
          RECONNECT_BASE_MS * 2 ** attempt,
          RECONNECT_MAX_MS,
        );
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setConnected(false);
    };
  }, [apiBase, enabled, addItem]);

  return { connected, items };
}
