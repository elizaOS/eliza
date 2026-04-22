import { afterEach, describe, expect, it } from "vitest";
import {
  errorsSuggestsHotpluggedBackendGone,
  shouldAttemptHotplugRetry,
  shouldInvalidateExternalProbeCache,
} from "./routing-hotplug-recovery";

describe("routing-hotplug-recovery", () => {
  afterEach(() => {
    delete process.env.OPENAI_BASE_URL;
  });

  it("detects LM Studio no-models-loaded body", () => {
    const err = {
      message: "APICallError",
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message:
            "No models loaded. Please load a model in the developer page or use the 'lms load' command.",
          type: "invalid_request_error",
          param: "model",
        },
      }),
    };
    expect(errorsSuggestsHotpluggedBackendGone(err)).toBe(true);
  });

  it("detects connection refused", () => {
    expect(
      errorsSuggestsHotpluggedBackendGone(
        new Error("fetch failed: ECONNREFUSED"),
      ),
    ).toBe(true);
  });

  it("does not treat generic 400 as hotplug", () => {
    expect(
      errorsSuggestsHotpluggedBackendGone({
        message: "bad",
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message: "invalid_api_key" } }),
      }),
    ).toBe(false);
  });

  it("invalidates for openai on self-hosted base URL when hotplug error", () => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1234/v1";
    expect(
      shouldInvalidateExternalProbeCache(
        "openai",
        new Error("No models loaded. Please load a model"),
      ),
    ).toBe(true);
  });

  it("does not invalidate openai for official API host", () => {
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    expect(
      shouldInvalidateExternalProbeCache(
        "openai",
        new Error("No models loaded. Please load a model"),
      ),
    ).toBe(false);
  });

  it("invalidates for ollama on transport errors", () => {
    expect(
      shouldInvalidateExternalProbeCache("ollama", new Error("ECONNREFUSED")),
    ).toBe(true);
  });

  it("treats AI SDK no-output stream error as retry for self-hosted openai", () => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1234/v1";
    expect(
      shouldAttemptHotplugRetry(
        "openai",
        new Error("No output generated. Check the stream for errors."),
      ),
    ).toBe(true);
    expect(
      shouldInvalidateExternalProbeCache(
        "openai",
        new Error("No output generated. Check the stream for errors."),
      ),
    ).toBe(true);
  });
});
