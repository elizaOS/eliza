import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// Mock matrix-js-sdk before importing
vi.mock("matrix-js-sdk", () => ({
  createClient: vi.fn(() => ({
    startClient: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    getRooms: vi.fn().mockReturnValue([]),
    joinRoom: vi.fn().mockResolvedValue({ roomId: "!joined:matrix.org" }),
    leave: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ event_id: "$sent_event" }),
    sendEvent: vi.fn().mockResolvedValue({ event_id: "$reaction_event" }),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendReadReceipt: vi.fn().mockResolvedValue(undefined),
    getRoomIdForAlias: vi.fn().mockResolvedValue({ room_id: "!resolved:matrix.org" }),
    getAccountData: vi.fn().mockReturnValue(null),
  })),
  ClientEvent: { Sync: "sync" },
  RoomEvent: { Timeline: "Room.timeline" },
  RoomMemberEvent: { Membership: "RoomMember.membership" },
  MatrixEvent: vi.fn().mockImplementation((data: Record<string, string>) => data),
}));

vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    Service: class MockService {
      protected runtime: IAgentRuntime = {} as IAgentRuntime;
      constructor(runtime?: IAgentRuntime) {
        if (runtime) this.runtime = runtime;
      }
    },
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    composePromptFromState: vi.fn().mockResolvedValue("mock prompt"),
    parseJSONObjectFromText: vi.fn(),
    ModelType: { TEXT_SMALL: "TEXT_SMALL" },
  };
});

import { joinRoom } from "../actions/joinRoom.js";
import { listRooms } from "../actions/listRooms.js";
import { sendMessage } from "../actions/sendMessage.js";
import { sendReaction } from "../actions/sendReaction.js";
import { roomStateProvider } from "../providers/roomState.js";
import { userContextProvider } from "../providers/userContext.js";
import {
  getMatrixLocalpart,
  getMatrixServerpart,
  getMatrixUserDisplayName,
  isValidMatrixRoomAlias,
  isValidMatrixRoomId,
  isValidMatrixUserId,
  MATRIX_SERVICE_NAME,
  MAX_MATRIX_MESSAGE_LENGTH,
  MatrixApiError,
  MatrixConfigurationError,
  MatrixEventTypes,
  MatrixNotConnectedError,
  MatrixPluginError,
  MatrixServiceNotInitializedError,
  type MatrixUserInfo,
  matrixMxcToHttp,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

describe("Matrix Constants", () => {
  it("MAX_MATRIX_MESSAGE_LENGTH is 4000", () => {
    expect(MAX_MATRIX_MESSAGE_LENGTH).toBe(4000);
  });

  it("MATRIX_SERVICE_NAME is 'matrix'", () => {
    expect(MATRIX_SERVICE_NAME).toBe("matrix");
  });
});

// ============================================================================
// Event Types
// ============================================================================

describe("MatrixEventTypes", () => {
  it("has all event values", () => {
    expect(MatrixEventTypes.MESSAGE_RECEIVED).toBe("MATRIX_MESSAGE_RECEIVED");
    expect(MatrixEventTypes.MESSAGE_SENT).toBe("MATRIX_MESSAGE_SENT");
    expect(MatrixEventTypes.ROOM_JOINED).toBe("MATRIX_ROOM_JOINED");
    expect(MatrixEventTypes.ROOM_LEFT).toBe("MATRIX_ROOM_LEFT");
    expect(MatrixEventTypes.INVITE_RECEIVED).toBe("MATRIX_INVITE_RECEIVED");
    expect(MatrixEventTypes.REACTION_RECEIVED).toBe("MATRIX_REACTION_RECEIVED");
    expect(MatrixEventTypes.TYPING_RECEIVED).toBe("MATRIX_TYPING_RECEIVED");
    expect(MatrixEventTypes.SYNC_COMPLETE).toBe("MATRIX_SYNC_COMPLETE");
    expect(MatrixEventTypes.CONNECTION_READY).toBe("MATRIX_CONNECTION_READY");
    expect(MatrixEventTypes.CONNECTION_LOST).toBe("MATRIX_CONNECTION_LOST");
  });
});

// ============================================================================
// Utility Functions
// ============================================================================

describe("isValidMatrixUserId", () => {
  it("returns true for valid user IDs", () => {
    expect(isValidMatrixUserId("@alice:matrix.org")).toBe(true);
    expect(isValidMatrixUserId("@bot:example.com")).toBe(true);
  });

  it("returns false for invalid user IDs", () => {
    expect(isValidMatrixUserId("alice:matrix.org")).toBe(false);
    expect(isValidMatrixUserId("@alice")).toBe(false);
    expect(isValidMatrixUserId("")).toBe(false);
  });
});

describe("isValidMatrixRoomId", () => {
  it("returns true for valid room IDs", () => {
    expect(isValidMatrixRoomId("!abc123:matrix.org")).toBe(true);
  });

  it("returns false for invalid room IDs", () => {
    expect(isValidMatrixRoomId("#general:matrix.org")).toBe(false);
    expect(isValidMatrixRoomId("abc:matrix.org")).toBe(false);
    expect(isValidMatrixRoomId("!abc")).toBe(false);
  });
});

describe("isValidMatrixRoomAlias", () => {
  it("returns true for valid room aliases", () => {
    expect(isValidMatrixRoomAlias("#general:matrix.org")).toBe(true);
  });

  it("returns false for invalid room aliases", () => {
    expect(isValidMatrixRoomAlias("!room:matrix.org")).toBe(false);
    expect(isValidMatrixRoomAlias("general:matrix.org")).toBe(false);
    expect(isValidMatrixRoomAlias("#general")).toBe(false);
  });
});

describe("getMatrixLocalpart", () => {
  it("extracts localpart from user ID", () => {
    expect(getMatrixLocalpart("@alice:matrix.org")).toBe("alice");
  });

  it("extracts localpart from room ID", () => {
    expect(getMatrixLocalpart("!abc:matrix.org")).toBe("abc");
  });

  it("extracts localpart from alias", () => {
    expect(getMatrixLocalpart("#general:matrix.org")).toBe("general");
  });

  it("returns input for plain string", () => {
    expect(getMatrixLocalpart("plaintext")).toBe("plaintext");
  });
});

describe("getMatrixServerpart", () => {
  it("extracts server part", () => {
    expect(getMatrixServerpart("@alice:matrix.org")).toBe("matrix.org");
  });

  it("returns empty string for no colon", () => {
    expect(getMatrixServerpart("plaintext")).toBe("");
  });
});

describe("getMatrixUserDisplayName", () => {
  it("uses display name when available", () => {
    const user: MatrixUserInfo = {
      userId: "@alice:matrix.org",
      displayName: "Alice Wonderland",
    };
    expect(getMatrixUserDisplayName(user)).toBe("Alice Wonderland");
  });

  it("falls back to localpart", () => {
    const user: MatrixUserInfo = {
      userId: "@alice:matrix.org",
    };
    expect(getMatrixUserDisplayName(user)).toBe("alice");
  });
});

describe("matrixMxcToHttp", () => {
  it("converts valid mxc URL", () => {
    const result = matrixMxcToHttp("mxc://matrix.org/abc123", "https://matrix.org");
    expect(result).toBe("https://matrix.org/_matrix/media/v3/download/matrix.org/abc123");
  });

  it("handles trailing slash", () => {
    const result = matrixMxcToHttp("mxc://matrix.org/abc123", "https://matrix.org/");
    expect(result).toBe("https://matrix.org/_matrix/media/v3/download/matrix.org/abc123");
  });

  it("returns undefined for non-mxc URL", () => {
    expect(matrixMxcToHttp("https://example.com/img.png", "https://matrix.org")).toBeUndefined();
  });

  it("returns undefined for malformed mxc", () => {
    expect(matrixMxcToHttp("mxc://matrix.org", "https://matrix.org")).toBeUndefined();
  });
});

// ============================================================================
// Error Types
// ============================================================================

describe("Error types", () => {
  it("MatrixPluginError", () => {
    const err = new MatrixPluginError("test");
    expect(err.message).toBe("test");
    expect(err.name).toBe("MatrixPluginError");
    expect(err).toBeInstanceOf(Error);
  });

  it("MatrixServiceNotInitializedError", () => {
    const err = new MatrixServiceNotInitializedError();
    expect(err.message).toContain("not initialized");
    expect(err).toBeInstanceOf(MatrixPluginError);
  });

  it("MatrixNotConnectedError", () => {
    const err = new MatrixNotConnectedError();
    expect(err.message).toContain("not connected");
    expect(err).toBeInstanceOf(MatrixPluginError);
  });

  it("MatrixConfigurationError with setting", () => {
    const err = new MatrixConfigurationError("Missing homeserver", "MATRIX_HOMESERVER");
    expect(err.settingName).toBe("MATRIX_HOMESERVER");
    expect(err).toBeInstanceOf(MatrixPluginError);
  });

  it("MatrixConfigurationError without setting", () => {
    const err = new MatrixConfigurationError("Bad config");
    expect(err.settingName).toBeUndefined();
  });

  it("MatrixApiError with errcode", () => {
    const err = new MatrixApiError("Rate limited", "M_LIMIT_EXCEEDED");
    expect(err.errcode).toBe("M_LIMIT_EXCEEDED");
    expect(err).toBeInstanceOf(MatrixPluginError);
  });

  it("MatrixApiError without errcode", () => {
    const err = new MatrixApiError("Server error");
    expect(err.errcode).toBeUndefined();
  });
});

// ============================================================================
// Actions
// ============================================================================

describe("sendMessage action", () => {
  it("has correct name", () => {
    expect(sendMessage.name).toBe("MATRIX_SEND_MESSAGE");
  });

  it("has description", () => {
    expect(sendMessage.description.length).toBeGreaterThan(0);
  });

  it("has similes", () => {
    expect(sendMessage.similes).toContain("SEND_MATRIX_MESSAGE");
  });

  it("has validate function", () => {
    expect(typeof sendMessage.validate).toBe("function");
  });

  it("has handler function", () => {
    expect(typeof sendMessage.handler).toBe("function");
  });

  it("has examples", () => {
    expect(sendMessage.examples).toBeDefined();
    expect(sendMessage.examples?.length).toBeGreaterThan(0);
  });

  it("validate returns true for matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const result = await sendMessage.validate(runtime, message);
    expect(result).toBe(true);
  });

  it("validate returns false for non-matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "discord" } } as Memory;
    const result = await sendMessage.validate(runtime, message);
    expect(result).toBe(false);
  });
});

describe("sendReaction action", () => {
  it("has correct name", () => {
    expect(sendReaction.name).toBe("MATRIX_SEND_REACTION");
  });

  it("has description", () => {
    expect(sendReaction.description.length).toBeGreaterThan(0);
  });

  it("has similes", () => {
    expect(sendReaction.similes?.length).toBeGreaterThan(0);
  });

  it("validate returns true for matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const result = await sendReaction.validate(runtime, message);
    expect(result).toBe(true);
  });

  it("validate returns false for non-matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "slack" } } as Memory;
    const result = await sendReaction.validate(runtime, message);
    expect(result).toBe(false);
  });
});

describe("listRooms action", () => {
  it("has correct name", () => {
    expect(listRooms.name).toBe("MATRIX_LIST_ROOMS");
  });

  it("has description", () => {
    expect(listRooms.description.length).toBeGreaterThan(0);
  });

  it("has similes including common variants", () => {
    expect(listRooms.similes).toContain("LIST_MATRIX_ROOMS");
  });

  it("validate returns true for matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const result = await listRooms.validate(runtime, message);
    expect(result).toBe(true);
  });
});

describe("joinRoom action", () => {
  it("has correct name", () => {
    expect(joinRoom.name).toBe("MATRIX_JOIN_ROOM");
  });

  it("has description", () => {
    expect(joinRoom.description.length).toBeGreaterThan(0);
  });

  it("validate returns true for matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const result = await joinRoom.validate(runtime, message);
    expect(result).toBe(true);
  });

  it("validate returns false for non-matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "nostr" } } as Memory;
    const result = await joinRoom.validate(runtime, message);
    expect(result).toBe(false);
  });
});

// ============================================================================
// Providers
// ============================================================================

describe("roomStateProvider", () => {
  it("has correct name", () => {
    expect(roomStateProvider.name).toBe("matrixRoomState");
  });

  it("has description mentioning room", () => {
    expect(roomStateProvider.description?.toLowerCase()).toContain("room");
  });

  it("returns empty for non-matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "discord" } } as Memory;
    const state = {} as State;

    const result = await roomStateProvider.get(runtime, message, state);

    expect(result.text).toBe("");
  });

  it("returns disconnected when no service", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue(null),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const state = {} as State;

    const result = await roomStateProvider.get(runtime, message, state);

    expect(result.data).toHaveProperty("connected", false);
  });

  it("returns room state when connected", async () => {
    const mockService = {
      isConnected: vi.fn().mockReturnValue(true),
      getUserId: vi.fn().mockReturnValue("@bot:matrix.org"),
      getHomeserver: vi.fn().mockReturnValue("https://matrix.org"),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const state = {
      agentName: "TestBot",
      data: {
        room: {
          roomId: "!abc:matrix.org",
          name: "General",
          isEncrypted: true,
          isDirect: false,
          memberCount: 15,
        },
      },
    } as State;

    const result = await roomStateProvider.get(runtime, message, state);

    expect(result.data).toHaveProperty("connected", true);
    expect(result.data).toHaveProperty("roomId", "!abc:matrix.org");
    expect(result.data).toHaveProperty("isEncrypted", true);
    expect(result.data).toHaveProperty("userId", "@bot:matrix.org");
    expect(result.text).toContain("TestBot");
    expect(result.text).toContain("General");
    expect(result.text).toContain("encryption");
  });

  it("returns DM text for direct message rooms", async () => {
    const mockService = {
      isConnected: vi.fn().mockReturnValue(true),
      getUserId: vi.fn().mockReturnValue("@bot:m.org"),
      getHomeserver: vi.fn().mockReturnValue("https://m.org"),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const state = {
      agentName: "Bot",
      data: {
        room: {
          roomId: "!dm:m.org",
          isDirect: true,
          memberCount: 2,
        },
      },
    } as State;

    const result = await roomStateProvider.get(runtime, message, state);

    expect(result.text).toContain("direct message");
  });
});

describe("userContextProvider", () => {
  it("has correct name", () => {
    expect(userContextProvider.name).toBe("matrixUserContext");
  });

  it("has description mentioning user", () => {
    expect(userContextProvider.description?.toLowerCase()).toContain("user");
  });

  it("returns empty for non-matrix source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "nostr" } } as Memory;
    const state = {} as State;

    const result = await userContextProvider.get(runtime, message, state);

    expect(result.text).toBe("");
  });

  it("returns empty when no service", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue(null),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const state = {} as State;

    const result = await userContextProvider.get(runtime, message, state);

    expect(result.data).toEqual({});
  });

  it("returns empty when no sender info", async () => {
    const mockService = {
      isConnected: vi.fn().mockReturnValue(true),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "matrix" } } as Memory;
    const state = {} as State;

    const result = await userContextProvider.get(runtime, message, state);

    expect(result.data).toEqual({});
  });

  it("returns user context when sender info available", async () => {
    const mockService = {
      isConnected: vi.fn().mockReturnValue(true),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = {
      content: {
        source: "matrix",
        metadata: {
          senderInfo: {
            userId: "@alice:matrix.org",
            displayName: "Alice",
            avatarUrl: "mxc://matrix.org/avatar",
          },
        },
      },
    } as Memory;
    const state = { agentName: "TestBot" } as State;

    const result = await userContextProvider.get(runtime, message, state);

    expect(result.data).toHaveProperty("userId", "@alice:matrix.org");
    expect(result.data).toHaveProperty("displayName", "Alice");
    expect(result.data).toHaveProperty("localpart", "alice");
    expect(result.text).toContain("TestBot");
    expect(result.text).toContain("Alice");
    expect(result.text).toContain("Matrix");
  });
});
