/** Reject JSON-stream formatting stalls; never cap text inside JSON strings. */
import { ElizaError } from "@elizaos/core";

// This is a non-progress budget, not an output/content limit. JSON values and
// ordinary text retain their complete content; failure never becomes success.
const MAX_CONSECUTIVE_JSON_WHITESPACE = 4096;

export class StructuredOutputProgressGuard {
  private insideString = false;
  private escaped = false;
  private whitespace = 0;

  constructor(private readonly controller: AbortController) {}

  observe(chunk: string): void {
    for (const character of chunk) {
      if (this.insideString) {
        if (this.escaped) this.escaped = false;
        else if (character === "\\") this.escaped = true;
        else if (character === '"') this.insideString = false;
        continue;
      }
      if (character === " " || character === "\t" || character === "\r" || character === "\n") {
        this.whitespace++;
        if (this.whitespace > MAX_CONSECUTIVE_JSON_WHITESPACE) {
          const error = new ElizaError(
            "Structured output stopped making JSON progress; the incomplete request was aborted.",
            {
              code: "STRUCTURED_OUTPUT_STALLED",
              context: {
                consecutiveWhitespace: this.whitespace,
                limit: MAX_CONSECUTIVE_JSON_WHITESPACE,
              },
            }
          );
          this.controller.abort(error);
          throw error;
        }
      } else {
        this.whitespace = 0;
        if (character === '"') this.insideString = true;
      }
    }
  }
}
