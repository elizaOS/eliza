/** Deterministic host chat-prefill bridge used by Maps component tests. */

export const MAPS_TEST_CHAT_PREFILL_EVENT = "eliza:chat:prefill" as const;

export interface MapsTestChatPrefillDetail {
  text: string;
  select?: boolean;
}

export function dispatchChatPrefill(detail: MapsTestChatPrefillDetail): void {
  window.dispatchEvent(
    new CustomEvent<MapsTestChatPrefillDetail>(MAPS_TEST_CHAT_PREFILL_EVENT, {
      detail,
    }),
  );
}
