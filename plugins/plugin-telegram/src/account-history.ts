/**
 * Reads personal Telegram history from GramJS without local-cache substitution.
 * Provider chunks are traversal units, never a total result cap. A failed or
 * stalled traversal rejects instead of returning a successful partial history.
 */
import { ElizaError } from "@elizaos/core";
import { Api, type TelegramClient } from "telegram";
import { readBigIntFromBuffer } from "telegram/Helpers.js";
import { getPeerId } from "telegram/Utils.js";

export interface TelegramHistoryQuery {
  limit?: number;
  cursor?: string;
  before?: string;
  after?: string;
  threadId?: number;
  expectedPeerId?: string;
}

function dateBound(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ElizaError(
      "Provide an ISO timestamp for Telegram history bounds.",
      { code: "TELEGRAM_HISTORY_QUERY_INVALID" },
    );
  }
  return parsed / 1000;
}

export async function readTelegramAccountHistory(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  query: TelegramHistoryQuery = {},
  assertAdmission: () => Promise<void> = async () => undefined,
): Promise<Api.TypeMessage[]> {
  if (query.cursor !== undefined) {
    throw new ElizaError(
      "Telegram history returns the complete requested range. Remove the cursor or request an explicit result limit.",
      { code: "TELEGRAM_HISTORY_CURSOR_UNSUPPORTED" },
    );
  }
  if (
    query.limit !== undefined &&
    (!Number.isSafeInteger(query.limit) || query.limit < 1)
  ) {
    throw new ElizaError(
      "Telegram history limit must be a positive integer or omitted for complete history.",
      { code: "TELEGRAM_HISTORY_QUERY_INVALID" },
    );
  }
  const before = dateBound(query.before);
  const after = dateBound(query.after);
  if (before !== undefined && after !== undefined && after >= before) {
    throw new ElizaError("Telegram history after must precede before.", {
      code: "TELEGRAM_HISTORY_QUERY_INVALID",
    });
  }
  if (
    query.threadId !== undefined &&
    (!Number.isSafeInteger(query.threadId) || query.threadId < 1)
  ) {
    throw new ElizaError(
      "Telegram thread ID must be a positive provider message ID.",
      { code: "TELEGRAM_HISTORY_QUERY_INVALID" },
    );
  }
  const result: Api.TypeMessage[] = [];
  let offsetId = 0;
  let expectedPeerId = query.expectedPeerId;
  for (;;) {
    await assertAdmission();
    const parameters = {
      peer,
      offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit: 100,
      maxId: 0,
      minId: 0,
      hash: readBigIntFromBuffer(Buffer.alloc(8)),
    };
    let response: Api.messages.TypeMessages;
    try {
      response = await client.invoke(
        query.threadId === undefined
          ? new Api.messages.GetHistory(parameters)
          : new Api.messages.GetReplies({
              ...parameters,
              msgId: query.threadId,
            }),
      );
    } catch (cause) {
      // error-policy:J2 a provider failure cannot become a successful prefix.
      const seconds =
        cause instanceof Error &&
        "seconds" in cause &&
        typeof cause.seconds === "number"
          ? cause.seconds
          : undefined;
      throw new ElizaError(
        "Telegram history could not be completed. Retry after the connection or account authorization is restored.",
        {
          code: "TELEGRAM_HISTORY_READ_FAILED",
          cause,
          context:
            seconds === undefined ? undefined : { retryAfterSeconds: seconds },
        },
      );
    }
    if (
      response instanceof Api.messages.MessagesNotModified ||
      !Array.isArray(response.messages)
    ) {
      throw new ElizaError(
        "Telegram returned an unsupported history response. Retry the complete read.",
        { code: "TELEGRAM_HISTORY_PAGINATION_INVALID" },
      );
    }
    if (response.messages.length === 0) break;
    let previousId = offsetId || Number.POSITIVE_INFINITY;
    for (const message of response.messages) {
      if (
        !Number.isSafeInteger(message.id) ||
        message.id < 1 ||
        message.id >= previousId
      ) {
        throw new ElizaError(
          "Telegram history did not advance in provider order. Retry the complete read.",
          { code: "TELEGRAM_HISTORY_PAGINATION_INVALID" },
        );
      }
      previousId = message.id;
      if (!(message instanceof Api.MessageEmpty)) {
        const peerId = getPeerId(message.peerId);
        expectedPeerId ??= peerId;
        if (expectedPeerId !== peerId) {
          throw new ElizaError(
            "Telegram history returned a different peer. Re-select the intended conversation.",
            { code: "TELEGRAM_HISTORY_PEER_MISMATCH" },
          );
        }
        if (before !== undefined && message.date >= before) continue;
        if (after !== undefined && message.date <= after) continue;
      } else if (before !== undefined || after !== undefined) {
        // Deleted placeholders carry no timestamp and cannot satisfy a date bound.
        continue;
      }
      result.push(message);
      if (query.limit !== undefined && result.length === query.limit) {
        await assertAdmission();
        return result;
      }
    }
    offsetId = previousId;
  }
  await assertAdmission();
  return result;
}
