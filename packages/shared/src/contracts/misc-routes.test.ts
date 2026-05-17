import { describe, expect, it } from "vitest";
import {
  PostAgentEventRequestSchema,
  PostCustomActionGenerateRequestSchema,
  PostCustomActionRequestSchema,
  PostCustomActionTestRequestSchema,
  PostEmoteRequestSchema,
  PostIngestShareRequestSchema,
  PostTerminalRunRequestSchema,
  PutCustomActionRequestSchema,
} from "./misc-routes.js";

describe("PostIngestShareRequestSchema", () => {
  it("accepts an empty body", () => {
    expect(PostIngestShareRequestSchema.parse({})).toEqual({});
  });

  it("accepts a populated share", () => {
    const parsed = PostIngestShareRequestSchema.parse({
      source: "share-sheet",
      title: "Hello",
      url: "https://x.test",
      text: "body",
    });
    expect(parsed.title).toBe("Hello");
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostIngestShareRequestSchema.parse({ source: "x", extra: 1 }),
    ).toThrow();
  });
});

describe("PostEmoteRequestSchema", () => {
  it("accepts emoteId", () => {
    expect(PostEmoteRequestSchema.parse({ emoteId: "wave" })).toEqual({
      emoteId: "wave",
    });
  });

  it("accepts empty body", () => {
    expect(PostEmoteRequestSchema.parse({})).toEqual({});
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostEmoteRequestSchema.parse({ emoteId: "x", looped: true }),
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
    const parsed = PostTerminalRunRequestSchema.parse({
      command: "echo hi",
      clientId: { socketId: 7 },
      terminalToken: "tok",
      captureOutput: true,
    });
    expect(parsed.command).toBe("echo hi");
    expect(parsed.clientId).toEqual({ socketId: 7 });
    expect(parsed.captureOutput).toBe(true);
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
    expect(parsed.name).toBe("send slack");
    expect(parsed.description).toBe("sends a slack message");
    expect(parsed.handler.type).toBe("http");
    expect(parsed.enabled).toBe(true);
    expect(parsed.similes).toEqual([]);
    expect(parsed.parameters).toEqual([]);
  });

  it("accepts a shell action with parameters and similes", () => {
    const parsed = PostCustomActionRequestSchema.parse({
      name: "RUN_BUILD",
      description: "runs build",
      similes: ["BUILD"],
      parameters: [{ name: "target", description: "...", required: true }],
      handler: { type: "shell", command: "make build" },
      enabled: false,
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.similes).toEqual(["BUILD"]);
    expect(parsed.parameters[0]?.name).toBe("target");
  });

  it("accepts a code action", () => {
    expect(() =>
      PostCustomActionRequestSchema.parse({
        name: "CODE_X",
        description: "x",
        handler: { type: "code", code: "return 42" },
      }),
    ).not.toThrow();
  });

  it("rejects unknown handler type", () => {
    expect(() =>
      PostCustomActionRequestSchema.parse({
        name: "x",
        description: "y",
        handler: { type: "ftp", url: "ftp://" },
      }),
    ).toThrow();
  });

  it("rejects http handler with whitespace url", () => {
    expect(() =>
      PostCustomActionRequestSchema.parse({
        name: "x",
        description: "y",
        handler: { type: "http", method: "GET", url: " " },
      }),
    ).toThrow(/HTTP handler requires a url/);
  });

  it("rejects whitespace-only name", () => {
    expect(() =>
      PostCustomActionRequestSchema.parse({
        name: " ",
        description: "y",
        handler: { type: "shell", command: "ls" },
      }),
    ).toThrow(/name is required/);
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostCustomActionRequestSchema.parse({
        name: "x",
        description: "y",
        handler: { type: "shell", command: "ls" },
        nuke: true,
      }),
    ).toThrow();
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
    const parsed = PutCustomActionRequestSchema.parse({
      enabled: false,
      handler: { type: "shell", command: "ls" },
    });
    expect(parsed.handler?.type).toBe("shell");
    expect(parsed.enabled).toBe(false);
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
