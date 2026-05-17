import type { TestCase } from "@elizaos/core";
import { MAX_DM_LENGTH } from "./constants";
import { splitMessage } from "./service";

/**
 * Test suite for Instagram plugin
 */
export class InstagramTestSuite {
  name = "Instagram Plugin Tests";
  tests: TestCase[] = [
    {
      name: "Message splitting - short message",
      fn: async (): Promise<void> => {
        const msg = "Hello, world!";
        const parts = splitMessage(msg, MAX_DM_LENGTH);

        if (parts.length !== 1) {
          throw new Error(`Expected 1 part, got ${parts.length}`);
        }

        if (parts[0] !== msg) {
          throw new Error(`Expected "${msg}", got "${parts[0]}"`);
        }
      },
    },
    {
      name: "Message splitting - long message",
      fn: async (): Promise<void> => {
        const msg = "a".repeat(MAX_DM_LENGTH + 500);
        const parts = splitMessage(msg, MAX_DM_LENGTH);

        if (parts.length <= 1) {
          throw new Error(`Expected multiple parts, got ${parts.length}`);
        }

        for (const part of parts) {
          if (part.length > MAX_DM_LENGTH) {
            throw new Error(`Part exceeds max length: ${part.length}`);
          }
        }
      },
    },
    {
      name: "Message splitting - preserves content",
      fn: async (): Promise<void> => {
        const msg = "a".repeat(MAX_DM_LENGTH * 2);
        const parts = splitMessage(msg, MAX_DM_LENGTH);
        const rejoined = parts.join("");

        if (rejoined !== msg) {
          throw new Error("Split and rejoined message does not match original");
        }
      },
    },
  ] as TestCase[];
}
