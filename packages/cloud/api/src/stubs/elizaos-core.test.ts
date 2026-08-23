/**
 * Deterministic unit coverage for the workerd-safe @elizaos/core stub.
 * Drives the real module with no mocks: Worker-safe helpers run their actual
 * branches, runtime-only exports throw, and injected fetch/DNS collaborators
 * are the stub's documented GuardedFetchOptions hooks. The stub has no
 * comparator; connector and subscription registries are the only queues.
 */

import { afterEach, describe, expect, test } from "vitest";
import stubDefault, * as stub from "./elizaos-core";

const NOT_AVAILABLE =
  "@elizaos/core runtime APIs are not available in the Cloudflare Workers API bundle. Route agent runtime work through the agent-server sidecar.";

const DOCUMENT_PREFIX =
  "Answer the user request using the contextual documents";

const THROWING_EXPORTS = [
  "composeActionExamples",
  "formatActions",
  "formatActionNames",
  "composePromptFromState",
  "composePrompt",
  "parseJSONObjectFromText",
  "generateText",
  "generateObject",
  "getTokenForProvider",
  "trimTokens",
  "truncateToCompleteSentence",
  "parseKeyValueXml",
  "parseBooleanFromText",
  "parseCharacter",
  "formatMessages",
  "formatPosts",
  "getEntityDetails",
  "splitChunks",
  "createMessageMemory",
  "executePlannedToolCall",
  "gateDestructiveConfirmation",
] as const;

const TEST_OWNER = "test:elizaos-core-coverage";
const OTHER_OWNER = "test:elizaos-core-coverage-other";
const KNOWN_UUID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function unavailableMessage(name: string): string {
  return `${name}: ${NOT_AVAILABLE}`;
}

function expectUnavailable(fn: () => unknown, name: string): void {
  const message = unavailableMessage(name);
  expect(fn).toThrowError(message);
  try {
    fn();
    throw new Error(`expected ${name} to throw`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(message);
  }
}

function functionExport(
  name: (typeof THROWING_EXPORTS)[number],
): (...args: unknown[]) => never {
  return stub[name] as (...args: unknown[]) => never;
}

afterEach(() => {
  stub.unregisterConnectorSourceMetadataOwner(TEST_OWNER);
  stub.unregisterConnectorSourceMetadataOwner(OTHER_OWNER);
  stub.unregisterConnectorSourceMetadataOwner("manual");
});

describe("elizaos-core Worker stub", () => {
  test("does not expose queue, comparator, or capacity fields", () => {
    const record = stub as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    expect("capacity" in record).toBe(false);
    expect("comparator" in record).toBe(false);
    expect(record.queue).toBeUndefined();
    expect(record.capacity).toBeUndefined();
    expect(record.comparator).toBeUndefined();
  });

  test("default export shares identity with the named runtime constants", () => {
    expect(stubDefault.logger).toBe(stub.logger);
    expect(stubDefault.elizaLogger).toBe(stub.elizaLogger);
    expect(stubDefault.stringToUuid).toBe(stub.stringToUuid);
    expect(stubDefault.ContentType).toBe(stub.ContentType);
    expect(stubDefault.DEFAULT_CEREBRAS_TEXT_MODEL).toBe("gemma-4-31b");
  });

  test("model and media constants match the source literals", () => {
    expect(stub.DEFAULT_CEREBRAS_TEXT_MODEL).toBe("gemma-4-31b");
    expect(stub.DEFAULT_ELIZA_CLOUD_TEXT_MODEL).toBe(
      stub.DEFAULT_CEREBRAS_TEXT_MODEL,
    );
    expect(stub.DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL).toBe(
      stub.DEFAULT_CEREBRAS_TEXT_MODEL,
    );
    expect(stub.DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL).toBe("zai-glm-4.7");
    expect(stub.DEFAULT_MAX_BODY_BYTES).toBe(1_048_576);
    expect(stub.CLOUD_AUTH_SERVICE_TYPE).toBe(stub.ServiceType.CLOUD_AUTH);
    expect(stub.ContentType.IMAGE).toBe("image");
    expect(stub.EventType.MESSAGE_RECEIVED).toBe("MESSAGE_RECEIVED");
    expect(stub.ChannelType.DM).toBe("DM");
    expect(stub.ModelType.TEXT_SMALL).toBe("TEXT_SMALL");
    expect(stub.ServiceType.MEDIA_GENERATION).toBe("MEDIA_GENERATION");
    expect(stub.VECTOR_DIMS.SMALL).toBe(384);
    expect(stub.MemoryType.DOCUMENT).toBe("document");
  });

  test("documentsPluginCore is an empty compatibility surface", () => {
    expect(stub.documentsPluginCore.name).toBe("documents");
    expect(stub.documentsPluginCore.actions).toEqual([]);
    expect(stub.documentsPluginCore.providers).toEqual([]);
    expect(stub.documentsPluginCore.services).toEqual([]);
  });

  test("logger and elizaLogger are the same no-op object; child returns itself", () => {
    expect(stub.logger).toBe(stub.elizaLogger);
    expect(stub.logger.child()).toBe(stub.logger);
    expect(stub.logger.info()).toBeUndefined();
    expect(stub.logger.warn()).toBeUndefined();
    expect(stub.logger.error()).toBeUndefined();
    expect(stub.logger.debug()).toBeUndefined();
    expect(stub.logger.trace()).toBeUndefined();
    expect(stub.logger.fatal()).toBeUndefined();
    expect(stub.logger.success()).toBeUndefined();
    expect(stub.logger.log()).toBeUndefined();
  });
});

describe("document augmentation envelope", () => {
  test("hasDocumentAugmentationEnvelope is false for non-strings and empty", () => {
    expect(stub.hasDocumentAugmentationEnvelope(undefined)).toBe(false);
    expect(stub.hasDocumentAugmentationEnvelope(null)).toBe(false);
    expect(stub.hasDocumentAugmentationEnvelope(12)).toBe(false);
    expect(stub.hasDocumentAugmentationEnvelope("")).toBe(false);
    expect(stub.hasDocumentAugmentationEnvelope("user said hello")).toBe(false);
  });

  test("hasDocumentAugmentationEnvelope matches after leading whitespace", () => {
    expect(stub.hasDocumentAugmentationEnvelope(DOCUMENT_PREFIX)).toBe(true);
    expect(
      stub.hasDocumentAugmentationEnvelope(`  \n${DOCUMENT_PREFIX} more`),
    ).toBe(true);
  });

  test("stripAugmentationForPersistence returns the same reference when there is nothing to strip", () => {
    const missing: { id: string; content?: unknown } = { id: "m" };
    expect(stub.stripAugmentationForPersistence(missing)).toBe(missing);
    expect(stub.stripAugmentationForPersistence(null)).toBe(null);
    expect(stub.stripAugmentationForPersistence(undefined)).toBe(undefined);
    const stringContent = { content: "not-an-object" };
    expect(stub.stripAugmentationForPersistence(stringContent)).toBe(
      stringContent,
    );
    const plain = { content: { text: "just a user message" } };
    expect(stub.stripAugmentationForPersistence(plain)).toBe(plain);
  });

  test("stripAugmentationForPersistence extracts the user_request and drops the language suffix", () => {
    const message = {
      id: "keep",
      content: {
        extra: true,
        text: [
          `${DOCUMENT_PREFIX} below.`,
          "<user_request>",
          "  fix the demo  ",
          "[Language instruction: Reply in Spanish]",
          "</user_request>",
        ].join("\n"),
      },
    };
    expect(stub.stripAugmentationForPersistence(message)).toEqual({
      id: "keep",
      content: { extra: true, text: "fix the demo" },
    });
  });
});

describe("unwrapUserMessageText and envelope detection", () => {
  test("containsExternalEnvelopeMaterial is false for empty and clean text", () => {
    expect(stub.containsExternalEnvelopeMaterial("")).toBe(false);
    expect(stub.containsExternalEnvelopeMaterial("hello world")).toBe(false);
  });

  test("containsExternalEnvelopeMaterial matches the marker, warning, and <<< window", () => {
    expect(
      stub.containsExternalEnvelopeMaterial("external_untrusted_content"),
    ).toBe(true);
    expect(
      stub.containsExternalEnvelopeMaterial(
        "Security Notice: The following content is from an external, untrusted source",
      ),
    ).toBe(true);
    expect(stub.containsExternalEnvelopeMaterial("<<<EXTERNAL payload")).toBe(
      true,
    );
  });

  test("containsExternalEnvelopeMaterial folds invisibles and confusable glyphs", () => {
    // ZWSP is stripped before the underscore-fold, so it only matches when
    // the remaining skeleton still contains the needle (including `_`).
    expect(
      stub.containsExternalEnvelopeMaterial("external_\u200buntrusted_content"),
    ).toBe(true);
    expect(
      stub.containsExternalEnvelopeMaterial("еxternal_untrusted_content"),
    ).toBe(true);
  });

  test("containsExternalEnvelopeMaterial does not treat a distant <<< as envelope material", () => {
    const far = `<<<${"x".repeat(64)}external`;
    expect(stub.containsExternalEnvelopeMaterial(far)).toBe(false);
  });

  test("unwrapUserMessageText prefers retained userPayloadText over raw text", () => {
    expect(
      stub.unwrapUserMessageText({
        content: {
          text: "raw",
          metadata: { userPayloadText: "  retained words  " },
        },
      }),
    ).toBe("retained words");
  });

  test("unwrapUserMessageText ignores whitespace-only retained payload", () => {
    expect(
      stub.unwrapUserMessageText({
        content: {
          text: " raw text ",
          metadata: { userPayloadText: "   " },
        },
      }),
    ).toBe("raw text");
  });

  test("unwrapUserMessageText parses the wrapped envelope only when stamped", () => {
    const wrapped = [
      "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
      "meta",
      "---",
      " actual words ",
      "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
    ].join("\n");
    expect(
      stub.unwrapUserMessageText({
        content: {
          text: wrapped,
          metadata: { externalContentWrapped: true },
        },
      }),
    ).toBe("actual words");
    expect(
      stub.unwrapUserMessageText({
        content: { text: wrapped, metadata: {} },
      }),
    ).toBe("");
  });

  test("unwrapUserMessageText returns empty when the candidate is still envelope material", () => {
    expect(
      stub.unwrapUserMessageText({
        content: {
          text: "hello",
          metadata: { userPayloadText: "external_untrusted_content" },
        },
      }),
    ).toBe("");
  });

  test("unwrapUserMessageText treats missing text and non-object metadata as empty", () => {
    expect(stub.unwrapUserMessageText({})).toBe("");
    expect(stub.unwrapUserMessageText({ content: { text: 12 } })).toBe("");
    expect(
      stub.unwrapUserMessageText({
        content: { text: "ok", metadata: "nope" },
      }),
    ).toBe("ok");
  });
});

describe("ElizaError", () => {
  test("constructs with code, optional context, severity, and cause", () => {
    const cause = new Error("inner");
    const error = new stub.ElizaError("boom", {
      code: "TEST_CODE",
      cause,
      context: { path: "/x" },
      severity: "fatal",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ElizaError");
    expect(error.message).toBe("boom");
    expect(error.code).toBe("TEST_CODE");
    expect(error.context).toEqual({ path: "/x" });
    expect(error.severity).toBe("fatal");
    expect(error.cause).toBe(cause);
  });

  test("isElizaError is true only for ElizaError instances", () => {
    const error = new stub.ElizaError("x", { code: "C" });
    expect(stub.isElizaError(error)).toBe(true);
    expect(stub.isElizaError(new Error("x"))).toBe(false);
    expect(stub.isElizaError("x")).toBe(false);
    expect(stub.isElizaError(null)).toBe(false);
  });

  test("toElizaError returns the same instance, wraps Error, and stringifies others", () => {
    const existing = new stub.ElizaError("keep", { code: "KEEP" });
    expect(stub.toElizaError(existing)).toBe(existing);
    const wrapped = stub.toElizaError(new Error("orig"), "FALLBACK");
    expect(wrapped).toBeInstanceOf(stub.ElizaError);
    expect(wrapped.message).toBe("orig");
    expect(wrapped.code).toBe("FALLBACK");
    expect(stub.toElizaError("plain").message).toBe("plain");
    expect(stub.toElizaError("plain").code).toBe("UNCLASSIFIED");
    expect(stub.toElizaError(42).message).toBe("42");
  });
});

describe("settings, env, and paths", () => {
  test("resolveSetting prefers a present runtime value, including 0 and false", () => {
    const runtime = {
      getSetting: (key: string) => {
        if (key === "NUM") return 0;
        if (key === "FLAG") return false;
        if (key === "EMPTY") return "";
        return null;
      },
    };
    expect(stub.resolveSetting(runtime, "NUM")).toBe("0");
    expect(stub.resolveSetting(runtime, "FLAG")).toBe("false");
    expect(stub.resolveSetting(runtime, "EMPTY")).toBe("");
    expect(
      stub.resolveSetting(runtime, "MISSING", {
        env: { MISSING: " from-env " },
      }),
    ).toBe("from-env");
    expect(
      stub.resolveSetting(null, "MISSING", {
        env: { MISSING: "   " },
        defaultValue: "fallback",
      }),
    ).toBe("fallback");
    expect(stub.resolveSetting(undefined, "NOPE", { env: {} })).toBeUndefined();
  });

  test("getElizaNamespace reads ELIZA_NAMESPACE then defaults to eliza", () => {
    expect(stub.getElizaNamespace({ ELIZA_NAMESPACE: "  custom  " })).toBe(
      "custom",
    );
    expect(stub.getElizaNamespace({ ELIZA_NAMESPACE: "" })).toBe("eliza");
    expect(stub.getElizaNamespace({})).toBe("eliza");
  });

  test("resolveUserPath expands ~ using HOME, else /tmp", () => {
    const previous = process.env.HOME;
    process.env.HOME = "/Users/tester";
    try {
      expect(stub.resolveUserPath("~")).toBe("/Users/tester");
      expect(stub.resolveUserPath("~/state")).toBe("/Users/tester/state");
      expect(stub.resolveUserPath("/abs")).toBe("/abs");
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
    const missing = process.env.HOME;
    delete process.env.HOME;
    try {
      expect(stub.resolveUserPath("~")).toBe("/tmp");
    } finally {
      if (missing === undefined) delete process.env.HOME;
      else process.env.HOME = missing;
    }
  });

  test("resolveStateDir uses ELIZA_STATE_DIR or home/.namespace", () => {
    expect(
      stub.resolveStateDir({
        ELIZA_STATE_DIR: "/var/eliza",
        HOME: "/Users/tester",
      }),
    ).toBe("/var/eliza");
    expect(
      stub.resolveStateDir({
        HOME: "/Users/tester",
        ELIZA_NAMESPACE: "ns",
      }),
    ).toBe("/Users/tester/.ns");
    expect(stub.resolveStateDir({ HOME: "  " })).toMatch(/\/\.eliza$/);
  });

  test("isTruthyEnvValue accepts only the documented truthy strings", () => {
    expect(stub.isTruthyEnvValue("1")).toBe(true);
    expect(stub.isTruthyEnvValue(" TRUE ")).toBe(true);
    expect(stub.isTruthyEnvValue("yes")).toBe(true);
    expect(stub.isTruthyEnvValue("y")).toBe(true);
    expect(stub.isTruthyEnvValue("on")).toBe(true);
    expect(stub.isTruthyEnvValue("enabled")).toBe(true);
    expect(stub.isTruthyEnvValue("0")).toBe(false);
    expect(stub.isTruthyEnvValue("false")).toBe(false);
    expect(stub.isTruthyEnvValue("")).toBe(false);
    expect(stub.isTruthyEnvValue("  ")).toBe(false);
    expect(stub.isTruthyEnvValue(undefined)).toBe(false);
    expect(stub.isTruthyEnvValue(null)).toBe(false);
  });

  test("resolveAliasedEnvValue: empty env, missing key, first partner wins, self-alias skipped", () => {
    expect(stub.resolveAliasedEnvValue("KEY", [], null)).toBeUndefined();
    expect(stub.resolveAliasedEnvValue("KEY", undefined, {})).toBeUndefined();
    expect(
      stub.resolveAliasedEnvValue("KEY", [["KEY", "ALT"]], {
        KEY: "  direct  ",
      }),
    ).toBe("  direct  ");
    expect(
      stub.resolveAliasedEnvValue("KEY", [["KEY", "ALT"]], { KEY: "   " }),
    ).toBeUndefined();
    expect(
      stub.resolveAliasedEnvValue(
        "KEY",
        [
          ["KEY", "FIRST"],
          ["KEY", "SECOND"],
        ],
        { SECOND: "second", FIRST: "first" },
      ),
    ).toBe("first");
    expect(
      stub.resolveAliasedEnvValue("KEY", [["KEY", "KEY"]], { OTHER: "x" }),
    ).toBeUndefined();
    expect(
      stub.resolveAliasedEnvValue("MISSING", [["KEY", "ALT"]], {
        ALT: "from-alt",
      }),
    ).toBeUndefined();
    expect(stub.resolveAliasedEnvValue("KEY", [], { KEY: "present" })).toBe(
      "present",
    );
  });
});

describe("UUID helpers and owner entity", () => {
  test("stringToUuid returns a well-formed UUID unchanged", () => {
    expect(stub.stringToUuid(KNOWN_UUID)).toBe(KNOWN_UUID);
    expect(stub.stringToUuid(KNOWN_UUID.toUpperCase())).toBe(
      KNOWN_UUID.toUpperCase(),
    );
  });

  test("stringToUuid hashes non-UUID strings and numbers stably", () => {
    const fromString = stub.stringToUuid("agent-one");
    expect(fromString).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(stub.stringToUuid("agent-one")).toBe(fromString);
    expect(stub.stringToUuid(12)).toBe(stub.stringToUuid("12"));
    expect(stub.stringToUuid("agent-one")).not.toBe(
      stub.stringToUuid("agent-two"),
    );
  });

  test("stringToUuid throws TypeError when the value is not a string after coercion", () => {
    expect(() =>
      stub.stringToUuid(undefined as unknown as string),
    ).toThrowError(TypeError);
    try {
      stub.stringToUuid({} as unknown as string);
      throw new Error("expected TypeError");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("Value must be string");
    }
  });

  test("asUUID and UUID() reject empty and malformed values", () => {
    expect(stub.asUUID(KNOWN_UUID)).toBe(KNOWN_UUID);
    expect(() => stub.asUUID("")).toThrowError("Invalid UUID format: ");
    expect(() => stub.asUUID("not-a-uuid")).toThrowError(
      "Invalid UUID format: not-a-uuid",
    );
    expect(() => stub.UUID()).toThrowError("Invalid UUID format: ");
    expect(stub.UUID(KNOWN_UUID)).toBe(KNOWN_UUID);
  });

  test("createUniqueUuid returns the agent id when it equals the base user id", () => {
    expect(stub.createUniqueUuid({ agentId: KNOWN_UUID }, KNOWN_UUID)).toBe(
      KNOWN_UUID,
    );
  });

  test("createUniqueUuid hashes baseUserId:agentId, including a missing runtime", () => {
    expect(stub.createUniqueUuid({ agentId: "agent" }, "user")).toBe(
      stub.stringToUuid("user:agent"),
    );
    expect(stub.createUniqueUuid(null, "user")).toBe(
      stub.stringToUuid("user:"),
    );
    expect(stub.createUniqueUuid({}, "user")).toBe(stub.stringToUuid("user:"));
  });

  test("deterministicOwnerEntityId seeds from agentId-admin-entity", () => {
    expect(stub.deterministicOwnerEntityId("agent-1")).toBe(
      stub.stringToUuid("agent-1-admin-entity"),
    );
  });

  test("resolveOwnerEntityIdOrDefault uses the first configured owner, not a later UUID", () => {
    expect(
      stub.resolveOwnerEntityIdOrDefault({
        agentId: "agent-1",
        getSetting: (key) => {
          if (key === "ELIZA_ADMIN_ENTITY_ID") return KNOWN_UUID;
          return undefined;
        },
      }),
    ).toBe(KNOWN_UUID);

    expect(
      stub.resolveOwnerEntityIdOrDefault({
        agentId: "agent-1",
        getSetting: (key) => {
          if (key === "ELIZA_ADMIN_ENTITY_ID") return "not-a-uuid";
          if (key === "ELIZA_OWNER_CONTACTS_JSON") {
            return JSON.stringify({
              later: { entityId: OTHER_UUID },
            });
          }
          return undefined;
        },
      }),
    ).toBe(stub.deterministicOwnerEntityId("agent-1"));

    expect(
      stub.resolveOwnerEntityIdOrDefault({
        agentId: "agent-1",
        getSetting: (key) => {
          if (key === "ELIZA_OWNER_CONTACTS_JSON") {
            return JSON.stringify({
              skip: { entityId: "  " },
              keep: { entityId: `  ${KNOWN_UUID}  ` },
            });
          }
          return undefined;
        },
      }),
    ).toBe(KNOWN_UUID);
  });

  test("resolveOwnerEntityIdOrDefault skips array contacts and missing getSetting", () => {
    expect(
      stub.resolveOwnerEntityIdOrDefault({
        agentId: "agent-1",
        getSetting: (key) => {
          if (key === "ELIZA_OWNER_CONTACTS_JSON") return JSON.stringify([]);
          return undefined;
        },
      }),
    ).toBe(stub.deterministicOwnerEntityId("agent-1"));
    expect(stub.resolveOwnerEntityIdOrDefault({ agentId: "agent-1" })).toBe(
      stub.deterministicOwnerEntityId("agent-1"),
    );
  });

  test("resolveOwnerEntityIdOrDefault throws when contacts JSON is invalid", () => {
    expect(() =>
      stub.resolveOwnerEntityIdOrDefault({
        agentId: "agent-1",
        getSetting: () => "{not-json",
      }),
    ).toThrow(SyntaxError);
  });
});

describe("formatError, headers, trajectory, inference timing", () => {
  test("formatError uses Error.message, otherwise String()", () => {
    expect(stub.formatError(new Error("boom"))).toBe("boom");
    expect(stub.formatError("plain")).toBe("plain");
    expect(stub.formatError(9)).toBe("9");
  });

  test("addHeader returns empty when the body is empty, otherwise header then body", () => {
    expect(stub.addHeader("# Title", "")).toBe("");
    expect(stub.addHeader("# Title", "body")).toBe("# Title\nbody");
  });

  test("runWithTrajectoryContext and runWithTrajectoryPurpose just run the callback", async () => {
    expect(stub.runWithTrajectoryContext({ id: 1 }, () => 7)).toBe(7);
    await expect(
      stub.runWithTrajectoryPurpose("inbox", async () => "ok"),
    ).resolves.toBe("ok");
  });

  test("timeInferenceSpan runs fn; getInferenceTimer is undefined; recordInferenceSpan is a no-op", async () => {
    await expect(stub.timeInferenceSpan("n", async () => 3)).resolves.toBe(3);
    expect(stub.getInferenceTimer()).toBeUndefined();
    expect(stub.recordInferenceSpan("n", 1)).toBeUndefined();
  });
});

describe("parseJsonModelRecord", () => {
  test("returns null for empty, non-object, array, and invalid JSON", () => {
    expect(stub.parseJsonModelRecord("")).toBeNull();
    expect(stub.parseJsonModelRecord("   ")).toBeNull();
    expect(stub.parseJsonModelRecord("[]")).toBeNull();
    expect(stub.parseJsonModelRecord("null")).toBeNull();
    expect(stub.parseJsonModelRecord("true")).toBeNull();
    expect(stub.parseJsonModelRecord("{")).toBeNull();
  });

  test("strips a leading think block and a fenced code block", () => {
    expect(stub.parseJsonModelRecord('<think>reason</think>\n{"a":1}')).toEqual(
      { a: 1 },
    );
    expect(stub.parseJsonModelRecord('```json\n{"b":2}\n```')).toEqual({
      b: 2,
    });
    expect(stub.parseJsonModelRecord('```\n{"c":3}\n```')).toEqual({ c: 3 });
  });
});

describe("request/response body helpers", () => {
  test("readRequestBodyBuffer returns the bytes under the cap and throws on overflow", async () => {
    const ok = await stub.readRequestBodyBuffer(
      new Request("https://example.com", { method: "POST", body: "abc" }),
    );
    expect(ok?.toString("utf-8")).toBe("abc");
    await expect(
      stub.readRequestBodyBuffer(
        new Request("https://example.com", { method: "POST", body: "abcd" }),
        { maxBytes: 3 },
      ),
    ).rejects.toThrowError("Request body exceeds maximum size (3 bytes)");
  });

  test("readRequestBody decodes utf-8; empty body is empty string, not null", async () => {
    const text = await stub.readRequestBody(
      new Request("https://example.com", { method: "POST", body: "hi" }),
    );
    expect(text).toBe("hi");
    const empty = await stub.readRequestBody(
      new Request("https://example.com", { method: "POST", body: "" }),
    );
    expect(empty).toBe("");
  });

  test("readJsonBody requires a plain object unless requireObject is false", async () => {
    const object = await stub.readJsonBody(
      new Request("https://example.com", {
        method: "POST",
        body: '{"k":1}',
      }),
    );
    expect(object).toEqual({ k: 1 });
    const arrayRejected = await stub.readJsonBody(
      new Request("https://example.com", { method: "POST", body: "[1]" }),
    );
    expect(arrayRejected).toBeNull();
    const arrayAccepted = await stub.readJsonBody(
      new Request("https://example.com", { method: "POST", body: "[1]" }),
      undefined,
      { requireObject: false },
    );
    expect(arrayAccepted).toEqual([1]);
    const empty = await stub.readJsonBody(
      new Request("https://example.com", { method: "POST", body: "" }),
    );
    expect(empty).toBeNull();
  });

  test("readResponseWithLimit concatenates chunks and throws once over maxBytes", async () => {
    const under = await stub.readResponseWithLimit(
      new Response("hello", { status: 200 }),
      16,
    );
    expect(under.toString("utf-8")).toBe("hello");
    await expect(
      stub.readResponseWithLimit(new Response("hello", { status: 200 }), 2),
    ).rejects.toThrowError(/payload exceeds maxBytes 2/);
  });

  test("sendJson and sendJsonError use the documented defaults", async () => {
    const ok = stub.sendJson(undefined, { ok: true });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ ok: true });
    const created = stub.sendJson(undefined, { id: 1 }, 201);
    expect(created.status).toBe(201);
    const err = stub.sendJsonError(undefined, "nope");
    expect(err.status).toBe(400);
    await expect(err.json()).resolves.toEqual({ error: "nope" });
    const forbidden = stub.sendJsonError(undefined, "no", 403);
    expect(forbidden.status).toBe(403);
  });
});

describe("fetchWithSsrfGuard", () => {
  const noFetch = (): never => {
    throw new Error("fetch must not be reached for a blocked URL");
  };
  const publicDns = async () => [{ address: "93.184.216.34" }];

  test("blocks non-http schemes, localhost, internal names, and private literals", async () => {
    const blocked = [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "http://localhost/x",
      "http://metadata/x",
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://192.168.0.1/x",
      "http://172.16.0.1/x",
      "http://169.254.169.254/x",
      "http://100.64.0.1/x",
      "http://0.0.0.0/x",
      "http://192.0.2.1/x",
      "http://[::1]/x",
      "http://[fe80::1]/x",
      "http://[fd00::1]/x",
      "http://[::ffff:127.0.0.1]/x",
    ];
    for (const url of blocked) {
      await expect(
        stub.fetchWithSsrfGuard({ url, fetchImpl: noFetch }),
      ).rejects.toBeInstanceOf(stub.SsrfBlockedError);
    }
    // WHATWG URL rejects octet 256 before the SSRF checks run.
    await expect(
      stub.fetchWithSsrfGuard({
        url: "http://256.1.1.1/x",
        fetchImpl: noFetch,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("SsrfBlockedError name is SsrfBlockedError", async () => {
    try {
      await stub.fetchWithSsrfGuard({
        url: "http://127.0.0.1/x",
        fetchImpl: noFetch,
      });
      throw new Error("expected block");
    } catch (error) {
      expect(error).toBeInstanceOf(stub.SsrfBlockedError);
      expect((error as Error).name).toBe("SsrfBlockedError");
    }
  });

  test("public IPv4 literals skip DNS and fetch", async () => {
    let dnsCalls = 0;
    const { response, finalUrl, release } = await stub.fetchWithSsrfGuard({
      url: "http://8.8.8.8/ok",
      fetchImpl: async () => new Response("ok", { status: 200 }),
      dnsResolver: async () => {
        dnsCalls += 1;
        return [{ address: "1.1.1.1" }];
      },
    });
    expect(dnsCalls).toBe(0);
    expect(response.status).toBe(200);
    expect(finalUrl).toBe("http://8.8.8.8/ok");
    await expect(response.text()).resolves.toBe("ok");
    await release();
  });

  test("fails closed on DNS errors, empty answers, and any private answer", async () => {
    await expect(
      stub.fetchWithSsrfGuard({
        url: "https://example.com/x",
        fetchImpl: noFetch,
        dnsResolver: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrowError(
      /Unable to resolve hostname for SSRF screening: example.com/,
    );
    await expect(
      stub.fetchWithSsrfGuard({
        url: "https://example.com/x",
        fetchImpl: noFetch,
        dnsResolver: async () => [],
      }),
    ).rejects.toThrowError("Hostname resolved to no addresses: example.com");
    await expect(
      stub.fetchWithSsrfGuard({
        url: "https://example.com/x",
        fetchImpl: noFetch,
        dnsResolver: async () => [
          { address: "93.184.216.34" },
          { address: "10.0.0.1" },
        ],
      }),
    ).rejects.toThrowError(
      "Blocked hostname resolving to a private/reserved address: example.com",
    );
  });

  test("301 POST rewrites to GET and strips content headers; 303 non-GET also rewrites", async () => {
    const seen: Array<{ method: string; type: string | null }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        method: String(init?.method),
        type: new Headers(init?.headers).get("content-type"),
      });
      if (String(input).endsWith("/start")) {
        return new Response(null, {
          status: 301,
          headers: { location: "/next" },
        });
      }
      return new Response("done", { status: 200 });
    };
    const result = await stub.fetchWithSsrfGuard({
      url: "https://a.example.com/start",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      fetchImpl,
      dnsResolver: publicDns,
    });
    expect(result.finalUrl).toBe("https://a.example.com/next");
    expect(seen[0]).toEqual({ method: "POST", type: "application/json" });
    expect(seen[1]).toEqual({ method: "GET", type: null });
  });

  test("exceeds maxRedirects after the allowed hop count, including a zero cap", async () => {
    const looping = async (input: RequestInfo | URL) =>
      new Response(null, {
        status: 302,
        headers: { location: `${String(input)}x` },
      });
    await expect(
      stub.fetchWithSsrfGuard({
        url: "https://a.example.com/loop",
        maxRedirects: 0,
        fetchImpl: looping,
        dnsResolver: publicDns,
      }),
    ).rejects.toThrowError(
      "Exceeded 0 redirects fetching https://a.example.com/loop",
    );
  });
});

describe("connector source registry", () => {
  test("empty, missing, and non-string sources normalize to empty and expand to an empty set", () => {
    expect(stub.normalizeConnectorSource(undefined)).toBe("");
    expect(stub.normalizeConnectorSource(null)).toBe("");
    expect(stub.normalizeConnectorSource("   ")).toBe("");
    expect(stub.getConnectorSourceAliases(undefined)).toEqual([]);
    expect(stub.getConnectorSourceMetadata("")).toBeNull();
    expect(stub.isPassiveConnectorSource(undefined)).toBe(false);
    expect(stub.getConnectorIdentityMetadataMapping(null)).toBeNull();
    expect(stub.getConnectorWorldIdMetadataKeys(undefined)).toEqual([]);
    expect(stub.expandConnectorSourceFilter(undefined).size).toBe(0);
    expect(stub.expandConnectorSourceFilter([]).size).toBe(0);
  });

  test("builtin aliases collapse to the canonical source in Object.entries order", () => {
    expect(stub.normalizeConnectorSource("Discord-Local")).toBe("discord");
    expect(stub.normalizeConnectorSource("telegram-account")).toBe("telegram");
    expect(stub.normalizeConnectorSource("telegramaccount")).toBe("telegram");
    expect(stub.getConnectorSourceAliases("sms")).toEqual(["sms"]);
    expect(stub.expandConnectorSourceFilter(["telegram"])).toEqual(
      new Set(["telegram", "telegram-account", "telegramaccount"]),
    );
  });

  test("an unknown single source is its own canonical alias", () => {
    expect(stub.normalizeConnectorSource("  Signal  ")).toBe("signal");
    expect(stub.getConnectorSourceAliases("signal")).toEqual(["signal"]);
    // Module init already registers a discord owner, so mergeConnectorSourceMetadata
    // still produces an empty-fields object for unknown canonicals (not null).
    expect(stub.getConnectorSourceMetadata("signal")).toEqual({
      aliases: [],
      identityMetadataMapping: undefined,
      isPassive: undefined,
      sourceKind: undefined,
      worldIdMetadataKeys: undefined,
    });
  });

  test("registering metadata merges aliases, later owner wins typed fields, missing owner is a no-op", () => {
    stub.unregisterConnectorSourceMetadataOwner("does-not-exist");
    stub.registerConnectorSourceMetadata("  ", { isPassive: true }, TEST_OWNER);
    expect(stub.getConnectorSourceMetadata("  ")).toBeNull();

    stub.registerConnectorSourceMetadata(
      "signal",
      {
        aliases: ["signal-desktop"],
        sourceKind: "active",
        isPassive: false,
        identityMetadataMapping: { userIdField: "fromId" },
        worldIdMetadataKeys: ["teamId", "  ", 12 as unknown as string],
      },
      TEST_OWNER,
    );
    stub.registerConnectorSourceMetadata(
      "signal",
      { sourceKind: "passive", isPassive: true, aliases: ["signal-ios"] },
      OTHER_OWNER,
    );

    expect(stub.normalizeConnectorSource("signal-desktop")).toBe("signal");
    expect(stub.normalizeConnectorSource("signal-ios")).toBe("signal");
    expect(stub.isPassiveConnectorSource("signal")).toBe(true);
    expect(stub.getConnectorIdentityMetadataMapping("signal")).toEqual({
      userIdField: "fromId",
    });
    expect(stub.getConnectorWorldIdMetadataKeys("signal")).toEqual(["teamId"]);

    stub.unregisterConnectorSourceMetadataOwner(OTHER_OWNER);
    expect(stub.isPassiveConnectorSource("signal")).toBe(false);
  });

  test("registerConnectorSourceDefinitions and aliases no-op on empty lists", () => {
    stub.registerConnectorSourceDefinitions(null, TEST_OWNER);
    stub.registerConnectorSourceDefinitions(undefined, TEST_OWNER);
    stub.registerConnectorSourceDefinitions(
      [{ source: "matrix", aliases: ["element"] }],
      TEST_OWNER,
    );
    expect(stub.normalizeConnectorSource("element")).toBe("matrix");
    stub.registerConnectorSourceAliases("matrix", ["element-web"]);
    expect(stub.normalizeConnectorSource("element-web")).toBe("matrix");
  });

  test("empty owner string falls back to manual; blank owner unregister is ignored", () => {
    stub.registerConnectorSourceMetadata(
      "irc",
      { aliases: ["irc-local"] },
      "   ",
    );
    expect(stub.normalizeConnectorSource("irc-local")).toBe("irc");
    stub.unregisterConnectorSourceMetadataOwner("   ");
    expect(stub.normalizeConnectorSource("irc-local")).toBe("irc");
  });

  test("discord legacy metadata supplies identity mapping and world keys", () => {
    expect(stub.getConnectorIdentityMetadataMapping("discord")).toEqual({
      userIdField: "fromId",
      nameField: "entityName",
    });
    expect(stub.getConnectorWorldIdMetadataKeys("discord")).toEqual([
      "discordServerId",
      "discordChannelId",
    ]);
    expect(
      stub.getConnectorIdentityMetadataMapping("signal-missing"),
    ).toBeNull();
  });

  test("getConnectorIdentityMetadataMapping drops a blank userIdField", () => {
    stub.registerConnectorSourceMetadata(
      "blank-id",
      { identityMetadataMapping: { userIdField: "  " } },
      TEST_OWNER,
    );
    expect(stub.getConnectorIdentityMetadataMapping("blank-id")).toBeNull();
  });
});

describe("recent messages, wechat, and connector config", () => {
  test("getRecentMessagesData returns the array or an empty list", () => {
    expect(stub.getRecentMessagesData(undefined)).toEqual([]);
    expect(stub.getRecentMessagesData({ data: {} })).toEqual([]);
    expect(
      stub.getRecentMessagesData({
        data: {
          providers: { RECENT_MESSAGES: { data: { recentMessages: 1 } } },
        },
      }),
    ).toEqual([]);
    expect(
      stub.getRecentMessagesData({
        data: {
          providers: {
            RECENT_MESSAGES: { data: { recentMessages: [{ id: 1 }] } },
          },
        },
      }),
    ).toEqual([{ id: 1 }]);
  });

  test("isWechatConfigured: disabled, apiKey, and enabled account with apiKey", () => {
    expect(stub.isWechatConfigured(null)).toBe(false);
    expect(stub.isWechatConfigured({ enabled: false, apiKey: "k" })).toBe(
      false,
    );
    expect(stub.isWechatConfigured({ apiKey: "k" })).toBe(true);
    expect(
      stub.isWechatConfigured({
        accounts: { a: { enabled: false, apiKey: "k" } },
      }),
    ).toBe(false);
    expect(
      stub.isWechatConfigured({
        accounts: { a: { apiKey: "k" } },
      }),
    ).toBe(true);
  });

  test("isConnectorConfigured: non-object, disabled, tokens, wechat, enabled flag", () => {
    expect(stub.isConnectorConfigured("discord", null)).toBe(false);
    expect(stub.isConnectorConfigured("discord", "nope")).toBe(false);
    expect(
      stub.isConnectorConfigured("discord", { enabled: false, token: "t" }),
    ).toBe(false);
    expect(stub.isConnectorConfigured("discord", { botToken: "t" })).toBe(true);
    expect(stub.isConnectorConfigured("discord", { token: "t" })).toBe(true);
    expect(stub.isConnectorConfigured("discord", { apiKey: "k" })).toBe(true);
    expect(
      stub.isConnectorConfigured("wechat", {
        accounts: { a: { apiKey: "k" } },
      }),
    ).toBe(true);
    expect(stub.isConnectorConfigured("discord", { enabled: true })).toBe(true);
    expect(stub.isConnectorConfigured("discord", {})).toBe(false);
  });
});

describe("sensitive request policy and metadata redaction", () => {
  test("defaultSensitiveRequestPolicy branches on kind and payment context", () => {
    expect(
      stub.defaultSensitiveRequestPolicy("payment", "any_payer").actor,
    ).toBe("any_payer");
    expect(stub.defaultSensitiveRequestPolicy("payment").actor).toBe(
      "verified_payer",
    );
    expect(stub.defaultSensitiveRequestPolicy("oauth").actor).toBe(
      "owner_or_linked_identity",
    );
    const secret = stub.defaultSensitiveRequestPolicy("secret");
    expect(secret.requirePrivateDelivery).toBe(true);
    expect(secret.allowPublicLink).toBe(false);
    expect(
      stub.defaultSensitiveRequestPolicy("private_info").allowPublicLink,
    ).toBe(false);
  });

  test("redactSensitiveRequestMetadata redacts matching keys and recurses", () => {
    expect(stub.redactSensitiveRequestMetadata("plain")).toBe("plain");
    expect(stub.redactSensitiveRequestMetadata(null)).toBeNull();
    expect(
      stub.redactSensitiveRequestMetadata({
        apiKey: "secret",
        nested: { access_token: "t", ok: 1 },
        list: [{ password: "p" }, "x"],
      }),
    ).toEqual({
      apiKey: "[redacted]",
      nested: { access_token: "[redacted]", ok: 1 },
      list: [{ password: "[redacted]" }, "x"],
    });
  });
});

describe("PII and provider-integration re-exports", () => {
  test("detectPii finds an email span in real text", () => {
    const matches = stub.detectPii("write to alice@example.com please");
    expect(
      matches.some((match) => match.value.includes("alice@example.com")),
    ).toBe(true);
  });

  test("isSensitiveKeyName and redactSensitiveText drive the real redaction leaf", () => {
    expect(stub.isSensitiveKeyName("api_key")).toBe(true);
    expect(stub.isSensitiveKeyName("displayName")).toBe(false);
    expect(stub.redactSensitiveText("")).toBe("");
    const redacted = stub.redactSensitiveText(
      "API_KEY=abcdefghijklmnopqrstuvwxyz",
    );
    expect(redacted).not.toBe("API_KEY=abcdefghijklmnopqrstuvwxyz");
  });

  test("redactLogArgs returns an array of the same length", () => {
    const out = stub.redactLogArgs(["ok", { password: "secret-value" }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("ok");
  });

  test("assertValidScrubResult rejects a non-object (fail-closed)", () => {
    expect(() =>
      stub.assertValidScrubResult(null, { text: "hi", rulesetVersion: "1" }),
    ).toThrow(stub.PiiScrubFabricationError);
  });

  test("normalizeConnectedAccount accepts a complete account and rejects a missing one", () => {
    const account = stub.normalizeConnectedAccount({
      contractVersion: stub.PROVIDER_INTEGRATION_CONTRACT_VERSION,
      accountId: "acc-1",
      providerId: "github",
      mode: stub.CONNECTED_ACCOUNT_MODES[0],
      status: "connected",
      displayName: "Ada",
      capabilities: [
        { capabilityId: "read", riskLevel: "R0", status: "available" },
      ],
      lastUsedAt: null,
    });
    expect(account.accountId).toBe("acc-1");
    expect(account.mode).toBe("cloud");
    // Re-exported from core, so the thrown class is core's ElizaError, not
    // the Worker stub's same-named class (instanceof stub.ElizaError is false).
    try {
      stub.normalizeConnectedAccount({});
      throw new Error("expected normalizeConnectedAccount to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("ElizaError");
      expect(error).not.toBeInstanceOf(stub.ElizaError);
    }
  });
});

describe("throwing runtime stand-ins", () => {
  test.each(THROWING_EXPORTS)(
    "%s throws the unavailable Error with no arguments",
    (name) => {
      expectUnavailable(functionExport(name), name);
    },
  );

  test.each(THROWING_EXPORTS)(
    "%s throws the same Error with extra arguments (no overflow handling)",
    (name) => {
      expectUnavailable(
        () => functionExport(name)("single-element", { overflow: true }),
        name,
      );
    },
  );

  test.each(THROWING_EXPORTS)(
    "%s keeps throwing on repeated calls (no unlock after the first miss)",
    (name) => {
      const fn = functionExport(name);
      expectUnavailable(fn, name);
      expectUnavailable(fn, name);
    },
  );

  test("throwing exports are distinct closures, not a shared thrower", () => {
    expect(stub.composePrompt).not.toBe(stub.generateText);
    expect(stub.formatActions).not.toBe(stub.formatActionNames);
  });
});

describe("subscription auth registry and host-bridge no-ops", () => {
  const id = "elizaos-core-coverage-provider";

  test("missing id is undefined/false; last registration per id wins", () => {
    expect(stub.getSubscriptionAuthProvider("does-not-exist")).toBeUndefined();
    expect(stub.hasSubscriptionAuthProvider("does-not-exist")).toBe(false);
    stub.registerSubscriptionAuthProvider({ id });
    expect(stub.hasSubscriptionAuthProvider(id)).toBe(true);
    expect(stub.getSubscriptionAuthProvider(id)).toEqual({ id });
    const second = { id, extra: true } as { id: string };
    stub.registerSubscriptionAuthProvider(second);
    expect(stub.getSubscriptionAuthProvider(id)).toBe(second);
  });

  test("host-bridge setters and plugin loader are no-ops, not throws", () => {
    expect(stub.setAnthropicAccountPoolBridge({})).toBeUndefined();
    expect(stub.setCodingAgentSelectorBridge({})).toBeUndefined();
    expect(
      stub.registerAppRoutePluginLoader("id", async () => ({})),
    ).toBeUndefined();
    expect(stub.migrateLegacyRuntimeConfig({})).toBeUndefined();
    expect(stub.migrateLegacyRuntimeConfig(null)).toBeUndefined();
  });
});

describe("prompt helpers", () => {
  test("buildCanonicalSystemPrompt joins system, bio, and role; default name is the agent", () => {
    expect(stub.buildCanonicalSystemPrompt({})).toBe("");
    expect(
      stub.buildCanonicalSystemPrompt({
        character: { name: " Ada ", system: "  sys  ", bio: "  bio  " },
        userRole: " admin ",
      }),
    ).toBe("sys\n\n# About Ada\nbio\n\nuser_role: ADMIN");
    expect(
      stub.buildCanonicalSystemPrompt({
        character: { bio: [" one ", "", "two"] },
      }),
    ).toBe("# About the agent\none two");
  });

  test("resolveEffectiveSystemPrompt: own system key wins, then first system message, then fallback", () => {
    expect(
      stub.resolveEffectiveSystemPrompt({
        params: { system: "  from-params  " },
        fallback: "fb",
      }),
    ).toBe("from-params");
    expect(
      stub.resolveEffectiveSystemPrompt({
        params: { system: "   " },
        fallback: "fb",
      }),
    ).toBeUndefined();
    expect(
      stub.resolveEffectiveSystemPrompt({
        params: { system: 12 },
        fallback: "fb",
      }),
    ).toBeUndefined();
    expect(
      stub.resolveEffectiveSystemPrompt({
        params: {
          messages: [{ role: "system", content: "  from-message  " }],
        },
        fallback: "fb",
      }),
    ).toBe("from-message");
    expect(
      stub.resolveEffectiveSystemPrompt({
        params: { messages: [{ role: "user", content: "hi" }] },
        fallback: "  fb  ",
      }),
    ).toBe("fb");
    expect(stub.resolveEffectiveSystemPrompt({ fallback: "" })).toBeUndefined();
    expect(
      stub.resolveEffectiveSystemPrompt({
        params: {
          messages: [
            {
              role: "system",
              content: [{ text: " part-a " }, { text: "part-b" }],
            },
          ],
        },
      }),
    ).toBe("part-a\npart-b");
  });

  test("renderChatMessagesForPrompt skips empty content and optional duplicate system", () => {
    expect(stub.renderChatMessagesForPrompt(undefined)).toBe("");
    expect(
      stub.renderChatMessagesForPrompt([
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "  " },
      ]),
    ).toBe("system: sys\nuser: hi");
    expect(
      stub.renderChatMessagesForPrompt(
        [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        { omitDuplicateSystem: "sys" },
      ),
    ).toBe("user: hi");
  });
});

describe("runtime settings, cloud config, names, speech, ports", () => {
  test("toRuntimeSettings reads settings, then character.settings, then the object", () => {
    expect(stub.toRuntimeSettings(null)).toEqual({});
    expect(stub.toRuntimeSettings({ settings: { a: 1 } })).toEqual({ a: 1 });
    expect(
      stub.toRuntimeSettings({ character: { settings: { b: 2 } } }),
    ).toEqual({ b: 2 });
    expect(stub.toRuntimeSettings({ c: 3 })).toEqual({ c: 3 });
    expect(stub.toRuntimeSettings({ settings: [1] })).toEqual({});
  });

  test("cloud selection is true when enabled or apiKey is a string, including empty", () => {
    expect(stub.isCloudInferenceSelectedInConfig(null)).toBe(false);
    expect(stub.isCloudInferenceSelectedInConfig({})).toBe(false);
    expect(stub.isCloudInferenceSelectedInConfig({ cloud: [] })).toBe(false);
    expect(
      stub.isCloudInferenceSelectedInConfig({ cloud: { enabled: true } }),
    ).toBe(true);
    expect(
      stub.isCloudInferenceSelectedInConfig({ cloud: { apiKey: "" } }),
    ).toBe(true);
    expect(stub.isCloudConnected({ cloud: { enabled: true } })).toBe(true);
    expect(stub.isElizaCloudServiceSelectedInConfig).toBe(
      stub.isCloudInferenceSelectedInConfig,
    );
  });

  test("settingsDebugCloudSummary and sanitizeForSettingsDebug stay non-leaking", () => {
    expect(stub.isElizaSettingsDebugEnabled()).toBe(false);
    expect(stub.settingsDebugCloudSummary(null)).toEqual({
      enabled: false,
      hasApiKey: false,
    });
    expect(
      stub.settingsDebugCloudSummary({ cloud: { enabled: true, apiKey: "k" } }),
    ).toEqual({ enabled: true, hasApiKey: true });
    expect(stub.sanitizeForSettingsDebug(null)).toBeNull();
    expect(stub.sanitizeForSettingsDebug(undefined)).toBeUndefined();
    expect(stub.sanitizeForSettingsDebug({ a: 1 })).toBe("[object]");
    expect(stub.sanitizeForSettingsDebug("short")).toBe("short");
    expect(stub.sanitizeForSettingsDebug("123456789")).toBe("[redacted]");
    expect(stub.sanitizeForSettingsDebug(3)).toBe(3);
  });

  test("replaceNameTokens uses a replacer so $ in the name is literal", () => {
    expect(stub.replaceNameTokens("", "Ada")).toBe("");
    expect(stub.replaceNameTokens("hi {{name}} / {{agentName}}", "Ada")).toBe(
      "hi Ada / Ada",
    );
    expect(stub.replaceNameTokens("{{name}}", "$'oops")).toBe("$'oops");
  });

  test("replaceIndexedNameTokens is 1-based; a missing slot leaves the token", () => {
    expect(stub.replaceIndexedNameTokens("", ["Ada"])).toBe("");
    expect(
      stub.replaceIndexedNameTokens("{{name1}} {{user2}} {{name3}}", [
        "Ada",
        "Bob",
      ]),
    ).toBe("Ada Bob {{name3}}");
  });

  test("sanitizeSpeechText trims strings and maps non-strings to empty", () => {
    expect(stub.sanitizeSpeechText("  hi  ")).toBe("hi");
    expect(stub.sanitizeSpeechText(12)).toBe("");
    expect(stub.sanitizeSpeechText(undefined)).toBe("");
  });

  test("getRuntimeRouteHostContext prefers routeHostContext over hostContext", () => {
    expect(stub.getRuntimeRouteHostContext(null)).toBeUndefined();
    expect(stub.getRuntimeRouteHostContext({ hostContext: { a: 1 } })).toEqual({
      a: 1,
    });
    expect(
      stub.getRuntimeRouteHostContext({
        routeHostContext: { a: 2 },
        hostContext: { a: 1 },
      }),
    ).toEqual({ a: 2 });
  });

  test("getRequestContext is always undefined in the Worker stub", () => {
    expect(stub.getRequestContext()).toBeUndefined();
  });

  test("resolveDesktopApiPort and resolveApiSecurityConfig read env with defaults", () => {
    expect(stub.resolveDesktopApiPort({})).toBe(2138);
    expect(stub.resolveDesktopApiPort({ ELIZA_API_PORT: "3000" })).toBe(3000);
    expect(stub.resolveDesktopApiPort({ API_PORT: "9" })).toBe(9);
    expect(stub.resolveDesktopApiPort({ SERVER_PORT: "11" })).toBe(11);
    expect(stub.resolveDesktopApiPort({ ELIZA_API_PORT: "nope" })).toBeNaN();
    expect(stub.resolveApiSecurityConfig({})).toEqual({
      bindHost: "127.0.0.1",
      isLoopbackBind: true,
    });
    expect(
      stub.resolveApiSecurityConfig({ ELIZA_API_BIND: "0.0.0.0" }),
    ).toEqual({
      bindHost: "0.0.0.0",
      isLoopbackBind: false,
    });
    expect(
      stub.resolveApiSecurityConfig({ API_HOST: "::1" }).isLoopbackBind,
    ).toBe(true);
    expect(
      stub.resolveApiSecurityConfig({ API_HOST: "localhost" }).isLoopbackBind,
    ).toBe(true);
  });
});

describe("Service classes and throwing constructors", () => {
  test("Service constructs, stop is a no-op, start throws", async () => {
    const service = new stub.Service({ id: 1 });
    await expect(service.stop()).resolves.toBeUndefined();
    expectUnavailable(() => stub.Service.start(), "Service.start");
    expectUnavailable(() => stub.Service.start("overflow"), "Service.start");
  });

  test("IMediaGenerationService constructs and generateMedia throws", async () => {
    const media = new stub.IMediaGenerationService();
    expect(stub.IMediaGenerationService.serviceType).toBe(
      stub.ServiceType.MEDIA_GENERATION,
    );
    expect(media.capabilityDescription).toBe("Generates media from prompts.");
    await expect(media.generateMedia()).rejects.toThrowError(
      unavailableMessage("IMediaGenerationService.generateMedia"),
    );
  });

  test("AgentRuntime, DefaultMessageService, Semaphore, and BM25 constructors throw", () => {
    expectUnavailable(() => new stub.AgentRuntime(), "AgentRuntime");
    expectUnavailable(
      () => new stub.DefaultMessageService(),
      "DefaultMessageService",
    );
    expectUnavailable(() => new stub.Semaphore(), "Semaphore");
    expectUnavailable(() => new stub.Semaphore(8), "Semaphore");
    expectUnavailable(() => new stub.BM25(), "BM25");
    expectUnavailable(() => stub.BM25.prototype.search("query"), "BM25.search");
  });

  test("Semaphore instance methods throw even when constructed via Object.create", async () => {
    const fake = Object.create(stub.Semaphore.prototype) as stub.Semaphore;
    await expect(fake.acquire()).rejects.toThrowError(
      unavailableMessage("Semaphore.acquire"),
    );
    expectUnavailable(() => fake.release(), "Semaphore.release");
  });
});

describe("truncateWellFormed, stripHtmlRawTextElements, toWellFormedUnicode", () => {
  test("truncateWellFormed: empty on non-positive, full string when short, surrogate-safe cut", () => {
    expect(stub.truncateWellFormed("abc", 0)).toBe("");
    expect(stub.truncateWellFormed("abc", -1)).toBe("");
    expect(stub.truncateWellFormed("abc", Number.NaN)).toBe("");
    expect(stub.truncateWellFormed("abc", Number.POSITIVE_INFINITY)).toBe("");
    expect(stub.truncateWellFormed("abc", 8)).toBe("abc");
    expect(stub.truncateWellFormed("abc", 2)).toBe("ab");
    expect(stub.truncateWellFormed("a😀b", 2)).toBe("a");
    expect(stub.truncateWellFormed("a😀b", 3)).toBe("a😀");
    expect(stub.truncateWellFormed("\uD83D", 1)).toBe("\uD83D");
  });

  test("stripHtmlRawTextElements removes script and style, including unclosed and case-insensitive tags", () => {
    expect(
      stub.stripHtmlRawTextElements(
        "before<script><!--<script>hidden</script>still-hidden</script>after",
      ),
    ).toBe("before after");
    expect(stub.stripHtmlRawTextElements("a<style>x</style>b")).toBe("a b");
    expect(stub.stripHtmlRawTextElements("safe<script>secret")).toBe("safe ");
    expect(stub.stripHtmlRawTextElements("keep <div>ok</div>")).toBe(
      "keep <div>ok</div>",
    );
    expect(stub.stripHtmlRawTextElements("A<SCRIPT>x</SCRIPT>B")).toBe("A B");
  });

  test("toWellFormedUnicode replaces lone surrogates and keeps valid pairs", () => {
    expect(stub.toWellFormedUnicode("before\ud83dafter")).toBe("before�after");
    expect(stub.toWellFormedUnicode("a😀b")).toBe("a😀b");
    expect(stub.toWellFormedUnicode("")).toBe("");
  });
});
