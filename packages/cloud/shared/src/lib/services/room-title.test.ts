/**
 * Proves the room-title intent classifier respects Unicode word boundaries and
 * still persists the fallback title through the real repository boundary.
 *
 * "Supérieur" and "Hiện" must not read as the greetings "sup"/"hi", "helpers"
 * must not be a help request and "fixes" must not be a code request, while
 * punctuation-terminated intents ("hi!", "help?") keep classifying.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const ROOM = "room-title-test-1";
const NEW_CHAT = "New Chat";

type Room = { id: string; name?: string | null } | null;
type Msg = { content: unknown };

const findById = mock(async (_id: string): Promise<Room> => null);
const update = mock(async (_id: string, _patch: unknown) => undefined);
const findMessages = mock(async (_id: string, _opts?: unknown): Promise<Msg[]> => []);

// room-title.ts imports these relative to its own directory, which is this
// test's directory, so the same specifiers resolve to the same modules.
mock.module("../../db/repositories", () => ({
  memoriesRepository: { findMessages },
  roomsRepository: { findById, update },
}));

mock.module("../utils/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));

const { generateRoomTitle } = await import("./room-title");

const fromUser = (text: string): Msg => ({ content: { text, source: "user" } });

function givenRoom(messages: Msg[] = [fromUser("hi there")], name = NEW_CHAT) {
  findById.mockResolvedValueOnce({ id: ROOM, name });
  findMessages.mockResolvedValueOnce(messages);
}

async function titleFor(message: string): Promise<string | null> {
  givenRoom([fromUser(message)]);
  return generateRoomTitle(ROOM);
}

async function expectTitle(message: string, expected: string) {
  expect(await titleFor(message)).toBe(expected);
}

beforeEach(() => {
  findById.mockReset();
  update.mockReset();
  findMessages.mockReset();
  findById.mockResolvedValue(null);
  update.mockResolvedValue(undefined);
  findMessages.mockResolvedValue([]);
});

describe("room-title intent boundaries", () => {
  test("punctuated greetings classify and persist", async () => {
    givenRoom([fromUser("hi!")]);
    const title = await generateRoomTitle(ROOM);

    expect(title).toBe("New Conversation");
    expect(update).toHaveBeenCalledWith(ROOM, { name: "New Conversation" });
    expect(findMessages).toHaveBeenCalledWith(ROOM, { limit: 6 });
  });

  test("punctuated help still classifies", async () => {
    await expectTitle("help?", "Help Request");
  });

  test("accented words are not intent prefixes", async () => {
    await expectTitle("Supérieur design review", "Supérieur design review");
    const vietnamese = await titleFor("Hiện trạng máy chủ");
    expect(vietnamese).toBe("Hiện trạng máy chủ");
  });

  test("longer words are not shorter intents", async () => {
    const help = "Helpers wanted for the weekend";
    await expectTitle("helpers wanted for the weekend", help);
    await expectTitle("fixes the flaky test", "Fixes the flaky test");
    await expectTitle("explaining the tradeoffs", "Explaining the tradeoffs");
    await expectTitle("issues", "Issues");
  });

  test("exact intent prefixes keep their branches", async () => {
    await expectTitle("create the migration guide", "Coding Assistance");
    await expectTitle("explain the tradeoffs", "Explanation Request");
    await expectTitle("help me please", "Help Request");
    await expectTitle("is this ready", "Is this ready");
  });

  test("a changed classification still persists", async () => {
    const fallback = "Helpers wanted for the weekend";
    givenRoom([fromUser("helpers wanted for the weekend")]);
    const title = await generateRoomTitle(ROOM);

    expect(title).toBe(fallback);
    expect(update).toHaveBeenCalledWith(ROOM, { name: fallback });
  });
});

describe("room-title skip conditions", () => {
  test("missing room writes nothing", async () => {
    expect(await generateRoomTitle(ROOM)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  test("already titled room writes nothing", async () => {
    givenRoom([fromUser("hi there")], "Existing Chat");
    expect(await generateRoomTitle(ROOM)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  test("no messages writes nothing", async () => {
    givenRoom([]);
    expect(await generateRoomTitle(ROOM)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  test("no user message writes nothing", async () => {
    const agent = [{ content: { text: "assistant reply", source: "agent" } }];
    givenRoom(agent);
    expect(await generateRoomTitle(ROOM)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  test("too-short user text writes nothing", async () => {
    givenRoom([fromUser("hi")]);
    expect(await generateRoomTitle(ROOM)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
