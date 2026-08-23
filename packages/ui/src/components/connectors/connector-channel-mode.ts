/**
 * Global connector channel-mode lens (localStorage-backed): whether the
 * Connectors surface presents connectors as delegate channels (the agent works
 * inside the owner's own accounts, reading and replying as them) or as bot
 * channels (the agent has its own bot presence the owner messages from those
 * platforms). One shared store so the Settings header switch and the section
 * body stay in sync without context plumbing; persists across reloads.
 */
import { useSyncExternalStore } from "react";
import { shellLocalStorage } from "../../surface-realm-channel";

/**
 * The two ways a connector channel can relate to the agent:
 * - `"delegate"` — the agent acts through the owner's own account on the
 *   platform (personal Telegram, WhatsApp QR pairing,
 *   iMessage on the owner's number, …).
 * - `"bot"` — the agent is its own bot identity on the platform (bot tokens,
 *   OAuth workspace bots, hosted cloud gateways) that the owner chats with.
 */
export type ConnectorChannelMode = "delegate" | "bot";

export const CONNECTOR_CHANNEL_MODES: readonly ConnectorChannelMode[] = [
  "delegate",
  "bot",
];

const STORAGE_KEY = "eliza:connectors:channelMode";
const DEFAULT_MODE: ConnectorChannelMode = "delegate";

const listeners = new Set<() => void>();

function coerce(raw: string | null): ConnectorChannelMode {
  return raw === "bot" || raw === "delegate" ? raw : DEFAULT_MODE;
}

function readStorage(): ConnectorChannelMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    return coerce(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_MODE;
  }
}

// Cached snapshot: `getSnapshot` runs on every render of every subscriber, so
// it must return a stable primitive without per-render localStorage I/O.
let cachedMode = readStorage();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    const next = readStorage();
    if (next === cachedMode) return;
    cachedMode = next;
    for (const listener of listeners) {
      listener();
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ConnectorChannelMode {
  return cachedMode;
}

function getServerSnapshot(): ConnectorChannelMode {
  return DEFAULT_MODE;
}

export function getConnectorChannelMode(): ConnectorChannelMode {
  return cachedMode;
}

export function setConnectorChannelMode(mode: ConnectorChannelMode): void {
  if (typeof window !== "undefined") {
    try {
      shellLocalStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // localStorage unavailable (private mode, quota, …) — in-memory only.
    }
  }
  if (mode === cachedMode) return;
  cachedMode = mode;
  for (const listener of listeners) {
    listener();
  }
}

/** The current lens, subscribed — re-renders when any surface switches it. */
export function useConnectorChannelMode(): ConnectorChannelMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
