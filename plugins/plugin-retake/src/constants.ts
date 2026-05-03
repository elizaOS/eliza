export const TAG = "[retake]";
export const CHAT_POLL_INTERVAL_MS = 3_000;
export const VIEWER_STATS_POLL_INTERVAL_MS = 120_000;
export const LOCAL_API_PORT = Number(
  process.env.SERVER_PORT || process.env.PORT || "2138",
);
/** Max viewer chat message length sent to the LLM (truncated beyond this). */
export const MAX_CHAT_MESSAGE_LENGTH = 500;
