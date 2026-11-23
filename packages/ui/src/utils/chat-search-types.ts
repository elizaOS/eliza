/** One keyword-search hit from `GET /api/conversations/messages/search`. */
export interface ConversationMessageSearchResult {
  messageId: string;
  conversationId: string;
  roomId: string;
  role: "user" | "assistant";
  text: string;
  /** A `…keyword…` excerpt around the first match, for the result row. */
  snippet: string;
  createdAt: number;
  /** Relevance score (higher = better); the server sorts by it then recency. */
  score: number;
}
export interface ConversationMessageSearchResponse {
  results: ConversationMessageSearchResult[];
  count: number;
}
