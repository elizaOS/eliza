/**
 * Deterministic unit coverage for the spurious tool-pairing 400 lane: the
 * transient classifier must retry the provider's tool-pairing complaint (the
 * request-side normalizer makes that complaint structurally impossible, so it
 * can only be a provider-side false rejection — observed live on Cerebras
 * 2026-08-07/08), while genuine validation 400s stay non-retryable. Also pins
 * the debug instrumentation: role sequence + tool-call id pairing, never
 * message content.
 */
import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __INTERNAL_isSpuriousToolPairingRejection,
  __INTERNAL_isTransientProviderError,
  __INTERNAL_logToolPairingRejectionShape,
} from "../models/text.ts";

const CEREBRAS_PAIRING_MESSAGE =
  "Messages with role 'tool' must be a response to a preceeding message with 'tool_calls'";

function pairing400(): Error & { statusCode: number; responseBody: string } {
  const error = new Error("Bad Request") as Error & {
    statusCode: number;
    responseBody: string;
  };
  error.statusCode = 400;
  // Cerebras reports the real cause in a FLAT body, not the OpenAI envelope —
  // the AI SDK leaves error.message as the masked statusText.
  error.responseBody = JSON.stringify({
    message: CEREBRAS_PAIRING_MESSAGE,
    type: "invalid_request_error",
  });
  return error;
}

describe("spurious tool-pairing 400 classification", () => {
  it("classifies the Cerebras pairing complaint as transient (retryable)", () => {
    const error = pairing400();
    expect(__INTERNAL_isSpuriousToolPairingRejection(error)).toBe(true);
    expect(__INTERNAL_isTransientProviderError(error)).toBe(true);
  });

  it("matches OpenAI's correctly spelled variant too", () => {
    const error = new Error(
      'Bad Request: Messages with role "tool" must be a response to a preceding message with "tool_calls".'
    ) as Error & { statusCode: number };
    error.statusCode = 400;
    expect(__INTERNAL_isSpuriousToolPairingRejection(error)).toBe(true);
    expect(__INTERNAL_isTransientProviderError(error)).toBe(true);
  });

  it("keeps genuine validation 400s non-retryable", () => {
    for (const message of [
      "response_format: 'json_schema' is unsupported for this model",
      "messages.2.assistant.reasoning_content: property is unsupported",
      "tools.0.function.parameters: invalid JSON schema",
      "required field 'model' is missing",
    ]) {
      const error = new Error(message) as Error & { statusCode: number };
      error.statusCode = 400;
      expect(__INTERNAL_isSpuriousToolPairingRejection(error), message).toBe(false);
      expect(__INTERNAL_isTransientProviderError(error), message).toBe(false);
    }
  });

  it("still treats overload-worded 400s as transient", () => {
    const error = new Error("Encountered a server error, please try again") as Error & {
      statusCode: number;
    };
    error.statusCode = 400;
    expect(__INTERNAL_isTransientProviderError(error)).toBe(true);
  });
});

describe("tool-pairing rejection instrumentation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the role sequence and id pairing, never message content", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const secret = "the user's favorite color is teal";
    __INTERNAL_logToolPairingRejectionShape(pairing400(), {
      messages: [
        { role: "system", content: "persona" },
        { role: "user", content: secret },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tool-1-0", toolName: "MEMORY_CREATE", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tool-1-0",
              toolName: "MEMORY_CREATE",
              output: { type: "text", value: secret },
            },
          ],
        },
      ],
    });
    expect(debug).toHaveBeenCalledTimes(1);
    const [context, message] = debug.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain("pairing invariant holds");
    expect(context.status).toBe(400);
    expect(context.roleSequence).toEqual([
      { role: "system" },
      { role: "user" },
      { role: "assistant", toolCallIds: ["tool-1-0"] },
      { role: "tool", toolResultIds: ["tool-1-0"] },
    ]);
    // No secrets/PII: the structured context must not carry message content.
    expect(JSON.stringify(context)).not.toContain(secret);
  });

  it("stays silent for non-pairing errors", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const error = new Error("invalid JSON schema") as Error & { statusCode: number };
    error.statusCode = 400;
    __INTERNAL_logToolPairingRejectionShape(error, {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(debug).not.toHaveBeenCalled();
  });
});
