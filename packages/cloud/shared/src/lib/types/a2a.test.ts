/**
 * Covers the A2A protocol constructors and JSON-RPC envelope helpers.
 *
 * These build the objects that go on the wire between agents, so the contracts
 * that matter are the ones a peer parses structurally: the `type` discriminant
 * on every Part, the `jsonrpc: "2.0"` envelope, and the request `id` echoed
 * back unchanged — including `0` and `null`, which a truthiness-based
 * implementation would drop or rewrite, breaking correlation on the caller's
 * side.
 *
 * The error codes are a published contract, so their exact numeric values are
 * pinned rather than merely their presence.
 *
 * Pure constructors — no transport, no IO.
 */
import { describe, expect, test } from "bun:test";

import {
  A2AErrorCodes,
  createArtifact,
  createDataPart,
  createFilePart,
  createMessage,
  createTask,
  createTaskStatus,
  createTextPart,
  jsonRpcError,
  jsonRpcSuccess,
  type Part,
} from "./a2a";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("part constructors", () => {
  test("tag each part with its discriminant", () => {
    expect(createTextPart("hi").type).toBe("text");
    expect(createDataPart({ a: 1 }).type).toBe("data");
    expect(createFilePart({ uri: "https://x.test/f" } as never).type).toBe("file");
  });

  test("carry their payload unchanged", () => {
    expect(createTextPart("hi").text).toBe("hi");
    const data = { a: 1, nested: { b: 2 } };
    expect(createDataPart(data).data).toBe(data);
    const file = { uri: "https://x.test/f" } as never;
    expect(createFilePart(file).file).toBe(file);
  });

  test("carry optional metadata and leave it undefined when omitted", () => {
    const metadata = { source: "test" };
    expect(createTextPart("hi", metadata).metadata).toBe(metadata);
    expect(createTextPart("hi").metadata).toBeUndefined();
  });

  test("preserve an empty text part rather than dropping the field", () => {
    const part = createTextPart("");
    expect(part.text).toBe("");
    expect(part.type).toBe("text");
  });
});

describe("createMessage", () => {
  test("keeps the role and the exact parts array", () => {
    const parts: Part[] = [createTextPart("a"), createDataPart({ b: 1 })];
    const message = createMessage("user", parts);
    expect(message.role).toBe("user");
    expect(message.parts).toBe(parts);
  });

  test("supports the agent role and an empty parts list", () => {
    expect(createMessage("agent", []).role).toBe("agent");
    expect(createMessage("agent", []).parts).toEqual([]);
  });
});

describe("createTask / createTaskStatus", () => {
  test("nests the state under status with an ISO timestamp", () => {
    const task = createTask("task-1", "submitted");
    expect(task.id).toBe("task-1");
    expect(task.status.state).toBe("submitted");
    expect(task.status.timestamp).toMatch(ISO);
  });

  test("carries the context id and metadata when supplied", () => {
    const metadata = { tenant: "t1" };
    const task = createTask("t", "working", undefined, "ctx-1", metadata);
    expect(task.contextId).toBe("ctx-1");
    expect(task.metadata).toBe(metadata);
  });

  test("attaches an optional status message", () => {
    const message = createMessage("agent", [createTextPart("working")]);
    expect(createTask("t", "working", message).status.message).toBe(message);
    expect(createTaskStatus("completed", message).message).toBe(message);
  });

  test("stamps a standalone status with an ISO timestamp", () => {
    expect(createTaskStatus("completed").timestamp).toMatch(ISO);
  });
});

describe("createArtifact", () => {
  test("keeps the parts and every optional descriptor", () => {
    const parts: Part[] = [createTextPart("a")];
    const artifact = createArtifact(parts, "name", "desc", 2, { k: 1 });
    expect(artifact.parts).toBe(parts);
    expect(artifact.name).toBe("name");
    expect(artifact.description).toBe("desc");
    expect(artifact.index).toBe(2);
    expect(artifact.metadata).toEqual({ k: 1 });
  });

  test("preserves index 0 rather than treating it as absent", () => {
    expect(createArtifact([], undefined, undefined, 0).index).toBe(0);
  });
});

describe("JSON-RPC envelopes", () => {
  test("stamp the 2.0 version on both success and error", () => {
    expect(jsonRpcSuccess({ ok: true }, "1").jsonrpc).toBe("2.0");
    expect(jsonRpcError(-32600, "bad", "1").jsonrpc).toBe("2.0");
  });

  test("carry the result and never an error field on success", () => {
    const response = jsonRpcSuccess({ ok: true }, "1");
    expect(response.result).toEqual({ ok: true });
    expect(response).not.toHaveProperty("error");
  });

  test("carry code, message, and optional data on error", () => {
    const response = jsonRpcError(-32001, "not found", "1", { taskId: "t" });
    expect(response.error).toEqual({
      code: -32001,
      message: "not found",
      data: { taskId: "t" },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("echo the request id unchanged, including 0 and null", () => {
    // A truthiness-based implementation would drop or rewrite these and break
    // correlation on the caller's side.
    expect(jsonRpcSuccess({}, 0).id).toBe(0);
    expect(jsonRpcSuccess({}, null).id).toBeNull();
    expect(jsonRpcError(-1, "e", 0).id).toBe(0);
    expect(jsonRpcError(-1, "e", null).id).toBeNull();
    expect(jsonRpcSuccess({}, "req-1").id).toBe("req-1");
  });

  test("preserve a falsy result rather than dropping it", () => {
    expect(jsonRpcSuccess(null, "1").result).toBeNull();
    expect(jsonRpcSuccess(false, "1").result).toBe(false);
    expect(jsonRpcSuccess(0, "1").result).toBe(0);
  });
});

describe("A2AErrorCodes", () => {
  test("pins the standard JSON-RPC codes", () => {
    expect(A2AErrorCodes.PARSE_ERROR).toBe(-32700);
    expect(A2AErrorCodes.INVALID_REQUEST).toBe(-32600);
    expect(A2AErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
    expect(A2AErrorCodes.INVALID_PARAMS).toBe(-32602);
    expect(A2AErrorCodes.INTERNAL_ERROR).toBe(-32603);
  });

  test("pins the A2A-specific codes", () => {
    expect(A2AErrorCodes.TASK_NOT_FOUND).toBe(-32001);
    expect(A2AErrorCodes.TASK_NOT_CANCELABLE).toBe(-32002);
    expect(A2AErrorCodes.PUSH_NOTIFICATION_NOT_SUPPORTED).toBe(-32003);
    expect(A2AErrorCodes.UNSUPPORTED_OPERATION).toBe(-32004);
    expect(A2AErrorCodes.CONTENT_TYPE_NOT_SUPPORTED).toBe(-32005);
    expect(A2AErrorCodes.AUTHENTICATION_REQUIRED).toBe(-32010);
    expect(A2AErrorCodes.INSUFFICIENT_CREDITS).toBe(-32011);
    expect(A2AErrorCodes.RATE_LIMITED).toBe(-32012);
    expect(A2AErrorCodes.AGENT_BANNED).toBe(-32013);
  });

  test("assigns a distinct code to every name", () => {
    const values = Object.values(A2AErrorCodes);
    expect(new Set(values).size).toBe(values.length);
  });
});
