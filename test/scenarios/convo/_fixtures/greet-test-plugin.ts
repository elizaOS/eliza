/**
 * Fixture plugin used by the `greeting-dynamic` port. Lifted from the
 * original `greeting-dynamic.convo.test.ts` so its `GREET_USER` action stays
 * available once T4c re-adds dynamic-mode support in the new runner.
 *
 * Exact action contract preserved: validates true; handler returns
 * `{ success: true, text: "Hello there! Great to meet you. You said: ..." }`.
 */

import type { Plugin } from "@elizaos/core";

export const greetTestPlugin: Plugin = {
  name: "greet-test",
  description: "Test plugin that greets the user",
  actions: [
    {
      name: "GREET_USER",
      description:
        "Greet the user warmly. Use this action whenever the user says hello, introduces themselves, or starts a new conversation with a greeting.",
      similes: ["SAY_HELLO", "WELCOME", "INTRODUCE"],
      validate: async () => true,
      handler: async (_runtime, message, _state, _options, callback) => {
        const text =
          message.content &&
          typeof message.content === "object" &&
          "text" in message.content
            ? String(message.content.text)
            : "";
        const response = `Hello there! Great to meet you. You said: "${text}"`;

        if (callback) {
          await callback({ text: response, action: "GREET_USER" });
        }

        return { success: true, text: response };
      },
      examples: [
        [
          { name: "{{user1}}", content: { text: "hey there" } },
          {
            name: "{{agent}}",
            content: {
              text: "Hello! Great to meet you.",
              action: "GREET_USER",
            },
          },
        ],
        [
          { name: "{{user1}}", content: { text: "hi, I'm new here" } },
          {
            name: "{{agent}}",
            content: {
              text: "Welcome! Hello and nice to meet you.",
              action: "GREET_USER",
            },
          },
        ],
      ],
    },
  ],
};
