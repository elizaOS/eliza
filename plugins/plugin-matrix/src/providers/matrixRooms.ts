import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";
import type { MatrixService } from "../service.js";
import { MATRIX_SERVICE_NAME } from "../types.js";

const RELEVANCE_KEYWORDS = ["matrix", "room", "rooms"] as const;
const RELEVANCE_REGEX = /\b(?:matrix|rooms?)\b/i;

interface MatrixRoomEntry {
  roomId: string;
  name: string;
  alias: string;
  memberCount: number;
  isEncrypted: boolean;
}

export const matrixRoomsProvider: Provider = {
  name: "matrixRooms",
  description: "Lists Matrix rooms the bot has joined with member counts and encryption status.",
  descriptionCompressed: "Joined Matrix rooms (members, encryption).",
  dynamic: true,
  contexts: ["social", "connectors"],
  relevanceKeywords: [...RELEVANCE_KEYWORDS],
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const recentMessages = (state?.recentMessagesData as Memory[] | undefined) ?? [];
    const isRelevant =
      validateActionKeywords(message, recentMessages, [...RELEVANCE_KEYWORDS]) ||
      validateActionRegex(message, recentMessages, RELEVANCE_REGEX);
    if (!isRelevant) {
      return { text: "" };
    }

    if (message.content.source !== "matrix") {
      return { data: {}, values: {}, text: "" };
    }

    const service = runtime.getService(MATRIX_SERVICE_NAME) as MatrixService | undefined;
    if (!service?.isConnected()) {
      return { data: {}, values: {}, text: "" };
    }

    const rooms = await service.getJoinedRooms();
    const entries: MatrixRoomEntry[] = rooms.map((r) => ({
      roomId: r.roomId,
      name: r.name ?? "",
      alias: r.canonicalAlias ?? "",
      memberCount: r.memberCount,
      isEncrypted: r.isEncrypted,
    }));

    return {
      data: {
        roomCount: entries.length,
        rooms: entries,
      },
      values: {
        roomCount: entries.length,
      },
      text: JSON.stringify({
        matrix_rooms: {
          count: entries.length,
          items: entries,
        },
      }),
    };
  },
};

export default matrixRoomsProvider;
