import { logger, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpError, McpError } from "./error";

function runtimeWithModel(): { useModel: ReturnType<typeof vi.fn> } {
  return { useModel: vi.fn(async () => "friendly explanation") };
}

const state = { values: {} } as never;
const provider = { name: "test-server" } as never;
const message = { content: { text: "help" } } as never;

describe("McpError", () => {
  it("defaults to the UNKNOWN code and stable name", () => {
    const err = new McpError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("McpError");
    expect(err.code).toBe("UNKNOWN");
  });

  it("builds a connection error with optional details", () => {
    const plain = McpError.connectionError("server-a");
    expect(plain.code).toBe("CONNECTION_ERROR");
    expect(plain.message).toBe("Failed to connect to server 'server-a'");
    const detailed = McpError.connectionError("server-a", "refused");
    expect(detailed.message).toBe("Failed to connect to server 'server-a': refused");
  });

  it("builds tool and resource not-found errors with codes", () => {
    const tool = McpError.toolNotFound("tool1", "server-a");
    expect(tool.code).toBe("TOOL_NOT_FOUND");
    expect(tool.message).toContain("tool1");
    expect(tool.message).toContain("server-a");
    const resource = McpError.resourceNotFound("uri://x", "server-a");
    expect(resource.code).toBe("RESOURCE_NOT_FOUND");
    expect(resource.message).toContain("uri://x");
  });

  it("builds validation and server errors with optional details", () => {
    const validation = McpError.validationError("bad input");
    expect(validation.code).toBe("VALIDATION_ERROR");
    expect(validation.message).toBe("Validation error: bad input");
    const server = McpError.serverError("s1", "boom");
    expect(server.code).toBe("SERVER_ERROR");
    expect(server.message).toBe("Server error from 's1': boom");
  });
});

describe("handleMcpError", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  it("surfaces an Error failure as a failed ActionResult", async () => {
    const runtime = runtimeWithModel();
    const result = await handleMcpError(
      state,
      provider,
      new Error("boom"),
      runtime as never,
      message,
      "tool"
    );
    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to execute MCP tool");
    expect(result.values).toMatchObject({
      success: false,
      error: "boom",
      errorType: "tool",
    });
    expect(result.data).toMatchObject({ op: "call_tool", error: "boom" });
    expect(result.error).toBeInstanceOf(Error);
  });

  it("converts a non-Error throw (string) into a readable message", async () => {
    const result = await handleMcpError(
      state,
      provider,
      "plain failure",
      runtimeWithModel() as never,
      message,
      "tool"
    );
    expect(result.values?.error).toBe("plain failure");
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("plain failure");
  });

  it("stringifies opaque thrown objects instead of crashing", async () => {
    const result = await handleMcpError(
      state,
      provider,
      { raw: true },
      runtimeWithModel() as never,
      message,
      "tool"
    );
    expect(result.values?.error).toBe("[object Object]");
    expect(result.error).toBeInstanceOf(Error);
  });

  it("maps resource failures to read_resource ops", async () => {
    const result = await handleMcpError(
      state,
      provider,
      new Error("missing"),
      runtimeWithModel() as never,
      message,
      "resource"
    );
    expect(result.values?.errorType).toBe("resource");
    expect(result.data).toMatchObject({ op: "read_resource" });
  });

  it("asks the model for an explanation and calls back when provided", async () => {
    const runtime = runtimeWithModel();
    const callback = vi.fn();
    const result = await handleMcpError(
      state,
      provider,
      new Error("boom"),
      runtime as never,
      message,
      "tool",
      callback
    );
    expect(runtime.useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, {
      prompt: expect.any(String),
    });
    expect(callback).toHaveBeenCalledWith({
      text: "friendly explanation",
      actions: ["REPLY"],
    });
    expect(result.text).toBe("Failed to execute MCP tool");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not invoke the model without a callback", async () => {
    const runtime = runtimeWithModel();
    await handleMcpError(state, provider, new Error("boom"), runtime as never, message, "tool");
    expect(runtime.useModel).not.toHaveBeenCalled();
  });
});
