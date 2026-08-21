/**
 * Exercises the character-history pagination boundary with a pure parser and
 * a mocked route context; no HTTP server, database, or live model is used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHARACTER_HISTORY_WALK_DEPTH } from "../services/character-history.ts";
import {
  handleCharacterRoutes,
  parseCharacterHistoryLimit,
} from "./character-routes.ts";
import { invalidateConversationConnectionTopology } from "./conversation-connection-readiness.ts";

// Instrument the real invalidation collaborator: the spy still delegates to the
// live implementation, so call counts are observed on the actual code path.
vi.mock("./conversation-connection-readiness.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./conversation-connection-readiness.ts")
    >();
  return {
    ...actual,
    invalidateConversationConnectionTopology: vi.fn(
      actual.invalidateConversationConnectionTopology,
    ),
  };
});

const invalidateTopologySpy = vi.mocked(
  invalidateConversationConnectionTopology,
);

beforeEach(() => {
  invalidateTopologySpy.mockClear();
});

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
    expect(invalidateTopologySpy).not.toHaveBeenCalled();
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
    expect(invalidateTopologySpy).not.toHaveBeenCalled();
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
    expect(invalidateTopologySpy).toHaveBeenCalledTimes(1);
    expect(invalidateTopologySpy).toHaveBeenCalledWith(runtime);
  });
});

describe("PUT /api/character descriptor-only staging", () => {
  it("never runs submitted Proxy get/has traps while renaming examples", async () => {
    let trapCalls = 0;
    const trapHandler = {
      get(target: object, key: PropertyKey, receiver: unknown) {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      has(target: object, key: PropertyKey) {
        trapCalls += 1;
        return Reflect.has(target, key);
      },
    };
    const submittedExamples = new Proxy(
      [
        {
          examples: [
            { name: "{{agentName}}", content: { text: "hi from {{name}}" } },
          ],
        },
      ],
      trapHandler,
    );
    const submittedBio = new Proxy(["staged bio"], trapHandler);

    const character = {
      name: "Ada",
      bio: ["old"],
      messageExamples: [
        { examples: [{ name: "Ada", content: { text: "hi" } }] },
      ],
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
        bio: submittedBio,
        messageExamples: submittedExamples,
      })),
      pickRandomNames: vi.fn(),
      validateCharacter: vi.fn(() => ({ success: true })),
    } as never);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(trapCalls).toBe(0);
    expect(character.name).toBe("Eve");
    expect(character.bio).toEqual(["staged bio"]);
    expect(character.messageExamples).toEqual([
      { examples: [{ name: "Eve", content: { text: "hi from Eve" } }] },
    ]);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(invalidateTopologySpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a submitted accessor without invoking it or mutating anything", async () => {
    const hostileContent: Record<string, unknown> = { text: "hi" };
    let accessorCalls = 0;
    Object.defineProperty(hostileContent, "leak", {
      enumerable: true,
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error("ACCESSOR_INVOKED");
      },
    });
    const hostileBio: string[] = ["kept"];
    Object.defineProperty(hostileBio, "0", {
      enumerable: true,
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error("BIO_ACCESSOR_INVOKED");
      },
    });

    const character = {
      name: "Ada",
      bio: ["old"],
      messageExamples: [
        { examples: [{ name: "Ada", content: { text: "hi" } }] },
      ],
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
      state: { agentName: "Ada", runtime },
      json,
      error,
      readJsonBody: vi.fn(async () => ({
        name: "Eve",
        bio: hostileBio,
        messageExamples: [
          { examples: [{ name: "Eve", content: hostileContent }] },
        ],
      })),
      pickRandomNames: vi.fn(),
      validateCharacter: vi.fn(() => ({ success: true })),
    } as never);

    expect(handled).toBe(true);
    expect(accessorCalls).toBe(0);
    expect(error).toHaveBeenCalledWith(
      {},
      "Character payload exceeds the history walk budget",
      400,
    );
    expect(character).toEqual(original);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(invalidateTopologySpy).not.toHaveBeenCalled();
  });

  it("rejects an unbounded submitted bio before any runtime mutation", async () => {
    const character = { name: "Ada", bio: ["old"] };
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
        bio: [nestArr(MAX_CHARACTER_HISTORY_WALK_DEPTH + 4)],
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
    expect(invalidateTopologySpy).not.toHaveBeenCalled();
  });
});

/**
 * `CharacterSchema` accepts `{"username":""}`, `{"bio":""}`, `{"style":{}}`,
 * and the empty-array forms: that is how a caller CLEARS a character field.
 * Field PRESENCE must therefore survive staging independently of the
 * history-display normalization, which deliberately omits empty values.
 */
/** Read one argument off a `vi.fn()` call without fighting its empty tuple type. */
function mockCallArg(
  fn: ReturnType<typeof vi.fn>,
  call: number,
  index: number,
): unknown {
  return (fn.mock.calls as unknown as unknown[][])[call]?.[index];
}

function makeClearRuntime() {
  const character: Record<string, unknown> = {
    name: "Ada",
    username: "ada_live",
    bio: ["a long standing bio"],
    system: "live system",
    adjectives: ["curious"],
    topics: ["math"],
    style: { all: ["terse"], chat: ["warm"] },
    postExamples: ["a post"],
    messageExamples: [{ examples: [{ name: "Ada", content: { text: "hi" } }] }],
  };
  const updateAgent = vi.fn(async () => undefined);
  const createMemory = vi.fn(async () => undefined);
  const config = { agents: { list: [{ id: "main", default: true }] } };
  const saveConfig = vi.fn();
  return {
    character,
    updateAgent,
    createMemory,
    config,
    saveConfig,
    runtime: {
      agentId: "agent",
      character,
      updateAgent,
      createMemory,
    } as never,
  };
}

async function putClear(
  fixture: ReturnType<typeof makeClearRuntime>,
  body: Record<string, unknown>,
) {
  const json = vi.fn();
  const error = vi.fn();
  const handled = await handleCharacterRoutes({
    req: {} as never,
    res: {} as never,
    method: "PUT",
    pathname: "/api/character",
    state: {
      agentName: "Ada",
      runtime: fixture.runtime,
      config: fixture.config,
    },
    json,
    error,
    saveConfig: fixture.saveConfig,
    readJsonBody: vi.fn(async () => body),
    pickRandomNames: vi.fn(),
    validateCharacter: vi.fn(() => ({ success: true })),
  } as never);
  expect(handled).toBe(true);
  expect(error).not.toHaveBeenCalled();
  return { json, error };
}

describe("PUT /api/character clears schema-valid empty values", () => {
  it("clears username with an empty string", async () => {
    const fixture = makeClearRuntime();
    const { json } = await putClear(fixture, { username: "" });

    expect(fixture.character.username).toBe("");
    expect(json).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        ok: true,
        character: expect.objectContaining({ username: "" }),
      }),
    );
    expect(fixture.updateAgent).toHaveBeenCalledTimes(1);
    // History display deliberately omits an empty username (unchanged from the
    // base route), but the live character and the response are cleared.
    const metadata = mockCallArg(fixture.updateAgent, 0, 1) as {
      metadata: { character: Record<string, unknown> };
    };
    expect(Object.hasOwn(metadata.metadata.character, "username")).toBe(false);
    // The clear is a real history change: username present before, absent after.
    expect(fixture.createMemory).toHaveBeenCalledTimes(1);
    const memory = mockCallArg(fixture.createMemory, 0, 0) as {
      metadata: {
        fieldsChanged: string[];
        changes: Array<Record<string, unknown>>;
      };
    };
    expect(memory.metadata.fieldsChanged).toContain("username");
    expect(memory.metadata.changes[0]).toEqual({
      field: "username",
      before: "ada_live",
    });
  });

  it("clears bio with an empty string", async () => {
    const fixture = makeClearRuntime();
    await putClear(fixture, { bio: "" });

    expect(fixture.character.bio).toEqual([""]);
    const metadata = mockCallArg(fixture.updateAgent, 0, 1) as {
      metadata: { character: { bio?: string[] } };
    };
    expect(metadata.metadata.character.bio).toEqual([""]);
    expect(fixture.saveConfig).toHaveBeenCalledTimes(1);
    expect(fixture.config.agents.list[0]).toEqual(
      expect.objectContaining({ bio: [""] }),
    );
  });

  it("clears style with an empty object", async () => {
    const fixture = makeClearRuntime();
    await putClear(fixture, { style: {} });

    expect(fixture.character.style).toEqual({});
    expect(fixture.saveConfig).toHaveBeenCalledTimes(1);
    expect(fixture.config.agents.list[0]).toEqual(
      expect.objectContaining({ style: {} }),
    );
    // Style is absent from the history snapshot once it holds no known arrays.
    const metadata = mockCallArg(fixture.updateAgent, 0, 1) as {
      metadata: { character: Record<string, unknown> };
    };
    expect(Object.hasOwn(metadata.metadata.character, "style")).toBe(false);
    expect(fixture.createMemory).toHaveBeenCalledTimes(1);
  });

  it("clears the empty-collection forms", async () => {
    const fixture = makeClearRuntime();
    await putClear(fixture, {
      system: "",
      adjectives: [],
      topics: [],
      postExamples: [],
      messageExamples: [],
    });

    expect(fixture.character.system).toBe("");
    expect(fixture.character.adjectives).toEqual([]);
    expect(fixture.character.topics).toEqual([]);
    expect(fixture.character.postExamples).toEqual([]);
    expect(fixture.character.messageExamples).toEqual([]);
    expect(fixture.config.agents.list[0]).toEqual(
      expect.objectContaining({
        system: "",
        adjectives: [],
        topics: [],
        postExamples: [],
        messageExamples: [],
      }),
    );
  });

  it("keeps untouched fields when one field is cleared", async () => {
    const fixture = makeClearRuntime();
    await putClear(fixture, { username: "" });

    expect(fixture.character.name).toBe("Ada");
    expect(fixture.character.bio).toEqual(["a long standing bio"]);
    expect(fixture.character.style).toEqual({
      all: ["terse"],
      chat: ["warm"],
    });
    expect(fixture.character.messageExamples).toEqual([
      { examples: [{ name: "Ada", content: { text: "hi" } }] },
    ]);
    expect(invalidateTopologySpy).not.toHaveBeenCalled();
  });
});
