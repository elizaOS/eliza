/**
 * Wires Capacitor app lifecycle events to runtime state.
 *
 * The native shell (`packages/app/src/main.tsx`) bridges
 * `CapacitorApp.appStateChange` into `APP_RESUME_EVENT` /
 * `APP_PAUSE_EVENT`. This hook is the renderer-side consumer:
 *
 *  - On `APP_PAUSE_EVENT`:
 *    abort any in-flight chat stream before iOS suspends the process and
 *    persist the active conversation id so the next foreground can restore
 *    it (the storage bridge mirrors the key to Capacitor Preferences, so
 *    the value survives a WKWebView localStorage purge under memory
 *    pressure).
 *
 *  - On `APP_RESUME_EVENT`:
 *    re-probe `/api/health` to detect that the FGS / dev server respawned
 *    on a new port, clean up the "last assistant turn was an empty
 *    streaming placeholder" anomaly (mark interrupted), and trigger any
 *    pending background-runner wake deliveries.
 */
import type { MutableRefObject } from "react";
import { type ConversationMessage } from "../api";
/** Storage key for the last-known active conversation id. */
export declare const ACTIVE_CONVERSATION_STORAGE_KEY = "eliza:chat:activeConversationId";
interface UseAppLifecycleEventsParams {
    activeConversationIdRef: MutableRefObject<string | null>;
    conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
    chatAbortRef: MutableRefObject<AbortController | null>;
    setConversationMessages: (updater: ConversationMessage[] | ((prev: ConversationMessage[]) => ConversationMessage[])) => void;
}
export declare function useAppLifecycleEvents({ activeConversationIdRef, conversationMessagesRef, chatAbortRef, setConversationMessages, }: UseAppLifecycleEventsParams): void;
export {};
//# sourceMappingURL=useAppLifecycleEvents.d.ts.map