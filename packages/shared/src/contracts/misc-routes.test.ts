/**
 * Contract tests for the assorted "misc" route request schemas: share ingest,
 * agent-event injection, terminal command runs, and the custom-action
 * lifecycle (create/update/generate/test). Covers trimming and defaulting
 * (enabled/similes/parameters), the discriminated handler union
 * (http/shell/code) with per-variant required fields, clientId/params
 * passthrough, and strict extra-field rejection across every schema. Pure
 * in-process schema parsing — no server or mocks.
 */
import { describe, expect, it } from "vitest";
import {
  PostAgentEventRequestSchema,
  PostCustomActionGenerateRequestSchema,
  PostCustomActionRequestSchema,
  PostCustomActionTestRequestSchema,
  PostIngestShareRequestSchema,
  PostTerminalRunRequestSchema,
  PutCustomActionRequestSchema,
} from "./misc-routes.js";

describe("PostIngestShareRequestSchema", () => {
  it("accepts an empty body", () => {
    expect(PostIngestShareRequestSchema.parse({})).toEqual({});
  });

  it("accepts a populated share", () => {
    const input = {
      source: "share-sheet",
      title: "Hello",
      url: "https://x.test",
      text: "body",
    };
    expect(PostIngestShareRequestSchema.parse(input)).toEqual(input);
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostIngestShareRequestSchema.parse({ source: "x", extra: 1 }),
    ).toThrow();
  });
});

describe("PostAgentEventRequestSchema", () => {
  it("trims stream and roomId, keeps data", () => {
    expect(
      PostAgentEventRequestSchema.parse({
        stream: " inbox ",
        data: { foo: 1 },
        roomId: " r ",
      }),
    ).toEqual({ stream: "inbox", data: { foo: 1 }, roomId: "r" });
  });

  it("absorbs whitespace-only roomId", () => {
    expect(
      PostAgentEventRequestSchema.parse({ stream: "x", roomId: " " }),
    ).toEqual({ stream: "x" });
  });

  it("rejects whitespace-only stream", () => {
    expect(() => PostAgentEventRequestSchema.parse({ stream: " " })).toThrow(
      /stream is required/,
    );
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostAgentEventRequestSchema.parse({ stream: "x", agent: "y" }),
    ).toThrow();
  });
});

describe("PostTerminalRunRequestSchema", () => {
  it("accepts a populated body and passes clientId through unchanged", () => {
    const input = {
      command: "echo hi",
      clientId: { socketId: 7 },
      terminalToken: "tok",
      captureOutput: true,
    };
    expect(PostTerminalRunRequestSchema.parse(input)).toEqual(input);
  });

  it("requires command", () => {
    expect(() => PostTerminalRunRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostTerminalRunRequestSchema.parse({ command: "ls", env: {} }),
    ).toThrow();
  });
});

describe("PostCustomActionRequestSchema", () => {
  it("accepts an HTTP custom action", () => {
    const parsed = PostCustomActionRequestSchema.parse({
      name: " send slack ",
      description: " sends a slack message ",
      handler: { type: "http", method: "POST", url: "https://api.slack" },
    });
    expect(parsed).toEqual({
      name: "send slack",
      description: "sends a slack message",
      handler: { type: "http", method: "POST", url: "https://api.slack" },
      enabled: true,
      similes: [],
      parameters: [],
    });
  });

  it("accepts a shell action with parameters and similes", () => {
    const input = {
      name: "RUN_BUILD",
      description: "runs build",
      similes: ["BUILD"],
      parameters: [{ name: "target", description: "...", required: true }],
      handler: { type: "shell", command: "make build" },
      enabled: false,
    };
    expect(PostCustomActionRequestSchema.parse(input)).toEqual(input);
  });

  it("accepts a code action", () => {
    const input = {
      name: "CODE_X",
      description: "x",
      handler: { type: "code", code: "return 42" },
    };
    expect(PostCustomActionRequestSchema.parse(input)).toEqual({
      ...input,
      enabled: true,
      similes: [],
      parameters: [],
    });
  });

  it.each([
    ["unknown handler", { handler: { type: "ftp", url: "ftp://" } }, undefined],
    [
      "blank HTTP URL",
      { handler: { type: "http", method: "GET", url: " " } },
      /HTTP handler requires a url/,
    ],
    ["blank name", { name: " " }, /name is required/],
    ["extra field", { nuke: true }, undefined],
  ])("rejects %s", (_name, patch, error) => {
    expect(() =>
      PostCustomActionRequestSchema.parse({
        name: "x",
        description: "y",
        handler: { type: "shell", command: "ls" },
        ...patch,
      }),
    ).toThrow(error);
  });
});

describe("PostCustomActionGenerateRequestSchema", () => {
  it("trims prompt", () => {
    expect(
      PostCustomActionGenerateRequestSchema.parse({ prompt: "  hello  " }),
    ).toEqual({ prompt: "hello" });
  });

  it("rejects whitespace-only prompt", () => {
    expect(() =>
      PostCustomActionGenerateRequestSchema.parse({ prompt: " " }),
    ).toThrow(/prompt is required/);
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostCustomActionGenerateRequestSchema.parse({
        prompt: "x",
        model: "y",
      }),
    ).toThrow();
  });
});

describe("PostCustomActionTestRequestSchema", () => {
  it("accepts empty body and string-record params", () => {
    expect(PostCustomActionTestRequestSchema.parse({})).toEqual({});
    expect(
      PostCustomActionTestRequestSchema.parse({ params: { a: "b" } }),
    ).toEqual({ params: { a: "b" } });
  });

  it("rejects non-string param values", () => {
    expect(() =>
      PostCustomActionTestRequestSchema.parse({ params: { a: 1 } }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostCustomActionTestRequestSchema.parse({ params: {}, dryRun: true }),
    ).toThrow();
  });
});

describe("PutCustomActionRequestSchema", () => {
  it("accepts a fully empty patch", () => {
    expect(PutCustomActionRequestSchema.parse({})).toEqual({});
  });

  it("accepts partial updates including handler swap", () => {
    const input = { enabled: false, handler: { type: "shell", command: "ls" } };
    expect(PutCustomActionRequestSchema.parse(input)).toEqual(input);
  });

  it("rejects malformed handler discriminant", () => {
    expect(() =>
      PutCustomActionRequestSchema.parse({
        handler: { type: "ftp", url: "ftp://" },
      }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutCustomActionRequestSchema.parse({ enabled: true, name: "x", x: 1 }),
    ).toThrow();
  });
});
