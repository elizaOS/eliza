import type {
  AgentStartupDiagnostics,
  AgentStatus,
  ConversationMessage,
  CustomActionDef,
  StreamEventEnvelope,
} from "../api/client";
import { mergeStreamingText } from "../utils/streaming-text";
import { type ApiLikeError, type SlashCommandInput } from "./types";
export declare function isRecord(
  value: unknown,
): value is Record<string, unknown>;
export declare function parseAgentStatusEvent(
  data: Record<string, unknown>,
): AgentStatus | null;
/**
 * Parses `agentStatus` from a `desktopTrayMenuClick` payload when the main
 * process finishes menu reset (`itemId === "menu-reset-app-applied"`).
 */
export declare function parseAgentStatusFromMainMenuResetPayload(
  payload: unknown,
): AgentStatus | null;
export declare function parseAgentStartupDiagnostics(
  value: unknown,
): AgentStartupDiagnostics | undefined;
export declare function parseStreamEventEnvelopeEvent(
  data: Record<string, unknown>,
): StreamEventEnvelope | null;
export declare function parseConversationMessageEvent(
  value: unknown,
): ConversationMessage | null;
export declare function parseProactiveMessageEvent(
  data: Record<string, unknown>,
): {
  conversationId: string;
  message: ConversationMessage;
} | null;
export { mergeStreamingText };
export declare function computeStreamingDelta(
  existing: string,
  incoming: string,
): string;
export declare function normalizeStreamComparisonText(text: string): string;
export declare function shouldApplyFinalStreamText(
  streamed: string,
  finalText: string,
): boolean;
export declare function parseSlashCommandInput(
  text: string,
): SlashCommandInput | null;
export declare function normalizeCustomActionName(value: string): string;
export declare function parseCustomActionParams(
  action: CustomActionDef,
  argsRaw: string,
): {
  params: Record<string, string>;
  missingRequired: string[];
};
/** Plain-text variant of formatSearchBullet (uses `- ` bullets, no bold). */
export declare function formatSearchBullet(
  label: string,
  items: string[],
): string;
export declare function asApiLikeError(err: unknown): ApiLikeError | null;
/** API-error-aware variant that extracts path/status/message from structured errors. */
export declare function formatStartupErrorDetail(
  err: unknown,
): string | undefined;
//# sourceMappingURL=parsers.d.ts.map
