/**
 * Fixture plugin used by convo-domain scenarios. Lifted from the original
 * `echo-self-test.convo.test.ts` so the new scenario schema can register it
 * via a `custom` seed step.
 *
 * Keeps the exact action contract the original used: `ECHO_TEST` validates
 * true unconditionally and returns `{ success: true, text: "Echo: <input>" }`.
 */

import type { Plugin } from "@elizaos/core";

export const echoTestPlugin: Plugin = {
  name: "echo-test",
  description: "Test plugin that echoes user input",
  actions: [
    {
      name: "ECHO_TEST",
      description:
        "Echo back the user's message. Use this action when the user asks you to echo or repeat something.",
      similes: ["ECHO", "REPEAT", "SAY_BACK"],
      validate: async () => true,
      handler: async (_runtime, message, _state, _options, callback) => {
        const text =
          message.content &&
          typeof message.content === "object" &&
          "text" in message.content
            ? String(message.content.text)
            : "";
        const response = `Echo: ${text}`;

        if (callback) {
          await callback({ text: response, action: "ECHO_TEST" });
        }

        return { success: true, text: response };
      },
    },
  ],
};
