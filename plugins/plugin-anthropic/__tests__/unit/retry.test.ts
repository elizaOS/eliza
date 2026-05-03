import { describe, expect, it } from "vitest";
import { formatModelError } from "../../utils/retry";

describe("Anthropic retry error formatting", () => {
  it("preserves provider 400 details instead of flattening them", () => {
    const original = Object.assign(new Error("SDK fallback message"), {
      name: "AI_APICallError",
      statusCode: 400,
      data: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API.",
        },
      },
    });

    const formatted = formatModelError("TEXT_SMALL request using claude", original);

    expect(formatted.message).toContain(
      "Your credit balance is too low to access the Anthropic API."
    );
    expect(formatted.message).not.toContain(
      "An unexpected error occurred while processing the request."
    );
    expect(formatted.cause).toBe(original);
  });

  it("extracts provider details from responseBody when data is absent", () => {
    const original = Object.assign(new Error("invalid request"), {
      name: "AI_APICallError",
      statusCode: 404,
      responseBody: JSON.stringify({
        type: "error",
        error: {
          type: "not_found_error",
          message: "model: claude-missing",
        },
      }),
    });

    const formatted = formatModelError("TEXT_LARGE request using claude", original);

    expect(formatted.message).toContain("model: claude-missing");
  });

  it("keeps explicit authentication guidance for 401s", () => {
    const original = Object.assign(new Error("invalid x-api-key"), {
      statusCode: 401,
    });

    const formatted = formatModelError("TEXT_SMALL request using claude", original);

    expect(formatted.message).toContain(
      "Authentication failed. Check the configured Anthropic API key."
    );
  });
});
