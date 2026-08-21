/**
 * Exercises the character-history pagination boundary with a pure parser and
 * a mocked route context; no HTTP server, database, or live model is used.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_CHARACTER_HISTORY_WALK_DEPTH } from "../services/character-history.ts";
import {
  handleCharacterRoutes,
  parseCharacterHistoryLimit,
} from "./character-routes.ts";

describe("parseCharacterHistoryLimit", () => {
  it("keeps the default and accepts complete safe decimals", () => {
    expect(parseCharacterHistoryLimit(null)).toBe(20);
    expect(parseCharacterHistoryLimit("0")).toBe(0);
    expect(parseCharacterHistoryLimit("0007")).toBe(7);
    expect(parseCharacterHistoryLimit(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects partial, signed, padded, and unsafe values", () => {
    for (const value of [
      "",
      "10abc",
      "1.5",
      "1e2",
      "+2",
      "-1",
      " 20 ",
      String(Number.MAX_SAFE_INTEGER + 1),
      "999999999999999999999999999999",
    ]) {
      expect(parseCharacterHistoryLimit(value)).toBeNull();
    }
  });
});

describe("GET /api/character/history", () => {
  it("rejects malformed limits before reading history", async () => {
    const getMemories = vi.fn(async () => []);
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleCharacterRoutes({
      req: { url: "/api/character/history?limit=10abc" } as never,
      res: {} as never,
      method: "GET",
      pathname: "/api/character/history",
      state: {
        agentName: "Test Agent",
        runtime: { agentId: "agent", getMemories } as never,
      },
      json,
      error,
      readJsonBody: vi.fn(),
      pickRandomNames: vi.fn(),
      validateCharacter: vi.fn(() => ({ success: true })),
    } as never);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      {},
      "Invalid character history limit.",
      400,
    );
    expect(getMemories).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

describe("PUT /api/character history walk", () => {
  it("returns 400 instead of RangeError on cyclic messageExamples", async () => {
    const cyclic: Record<string, unknown> = { text: "hi" };
    cyclic.self = cyclic;
    const updateAgent = vi.fn();
    const createMemory = vi.fn();
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleCharacterRoutes({
      req: {} as never,
      res: {} as never,
      method: "PUT",
      pathname: "/api/character",
      state: {
        agentName: "Ada",
        runtime: {
          agentId: "agent",
          character: {
            name: "Ada",
            messageExamples: [[{ name: "Ada", content: cyclic }]],
          },
          updateAgent,
          createMemory,
        } as never,
      },
      json,
      error,
      readJsonBody: vi.fn(async () => ({ name: "Ada" })),
      pickRandomNames: vi.fn(),
      validateCharacter: vi.fn(() => ({ success: true })),
    } as never);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      {},
      "Character payload exceeds the history walk budget",
      400,
    );
    expect(updateAgent).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

function nestArr(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

function makePutRuntime(character: Record<string, unknown>) {
  const updateAgent = vi.fn(async () => undefined);
  const createMemory = vi.fn(async () => undefined);
  return {
    character,
    updateAgent,
    createMemory,
    runtime: {
      agentId: "agent",
      character,
      updateAgent,
      createMemory,
    } as never,
  };
}

describe("PUT /api/character stage-then-commit", () => {

  it("keeps runtime/update/history/topology untouched when the second bound fails", async () => {
    const character = {
      name: "Ada",
      bio: ["honest"],
      messageExamples: [[{ name: "Ada", content: { text: "hi" } }]],
    };
    const original = structuredClone(character);
    const { updateAgent, createMemory, runtime } = makePutRuntime(character);
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleCharacterRoutes({
      req: {} as never,
      res: {} as never,
      method: "PUT",
      pathname: "/api/character",
      state: {
        agentName: "Ada",
        runtime,
      },
      json,
      error,
      readJsonBody: vi.fn(async () => {
        const cyclic: Record<string, unknown> = {
          text: "hi",
          extra: nestArr(80),
        };
        cyclic.self = cyclic;
        return {
          name: "Eve",
          bio: ["mutated"],
          messageExamples: [{ examples: [{ name: "Eve", content: cyclic }] }],
        };
      }),
      pickRandomNames: vi.fn(),
      validateCharacter: vi.fn(() => ({ success: true })),
    } as never);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      {},
      "Character payload exceeds the history walk budget",
      400,
    );
    expect(character).toEqual(original);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("does not mutate runtime when a revoked Array Proxy is submitted", async () => {
    const { proxy, revoke } = Proxy.revocable(
      [[{ name: "Eve", content: { text: "hi" } }]],
      {},
    );
    revoke();
    const character = {
      name: "Ada",
      messageExamples: [[{ name: "Ada", content: { text: "hi" } }]],
    };
    const original = structuredClone(character);
    const { updateAgent, createMemory, runtime } = makePutRuntime(character);
    const error = vi.fn();
    const handled = await handleCharacterRoutes({
      req: {} as never,
      res: {} as never,
      method: "PUT",
      pathname: "/api/character",
      state: { agentName: "Ada", runtime },
      json: vi.fn(),
      error,
      readJsonBody: vi.fn(async () => ({
        name: "Eve",
        messageExamples: proxy,
      })),
      pickRandomNames: vi.fn(),
      validateCharacter: vi.fn(() => ({ success: true })),
    } as never);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      {},
      "Character payload exceeds the history walk budget",
      400,
    );
    expect(character).toEqual(original);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
  });

  it("commits runtime mutation only after both history bounds succeed", async () => {
    const character = {
      name: "Ada",
      bio: ["old"],
      messageExamples: [[{ name: "Ada", content: { text: "hi" } }]],
    };
    const { updateAgent, createMemory, runtime } = makePutRuntime(character);
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleCharacterRoutes({
      req: {} as never,
      res: {} as never,
      method: "PUT",
      pathname: "/api/character",
      state: { agentName: "Ada", runtime },
      json,
      error,
      readJsonBody: vi.fn(async () => ({
        name: "Eve",
        bio: ["new"],
      })),
      pickRandomNames: vi.fn(),
      validateCharacter: vi.fn(() => ({ success: true })),
    } as never);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(character.name).toBe("Eve");
    expect(character.bio).toEqual(["new"]);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ok: true, agentName: "Eve" }),
    );
  });
});
