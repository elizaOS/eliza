import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

type TypewriterLetter =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

function createLetterAction(letter: TypewriterLetter): Action {
  const upper = letter.toUpperCase();

  return {
    name: `TYPE_${upper}`,
    similes: [`TYPE_${upper}`, `TYPE_${letter}`],
    description: `Type the letter '${letter}' and append it to the accumulating typed text for benchmarking action chaining.`,
    validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
      return true;
    },
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      state?: State,
      _options?: Record<string, unknown>,
      callback?: HandlerCallback
    ): Promise<ActionResult> => {
      const current = state?.values?.typedText ?? "";
      const next = `${current}${letter}`;

      // Optional immediate feedback for visibility during bench runs
      if (callback) {
        await callback({
          text: next,
          source: message.content.source,
        });
      }

      return {
        success: true,
        text: next,
        values: {
          typedText: next,
        },
        data: {
          letter,
          length: next.length,
        },
      } satisfies ActionResult;
    },
    examples: [
      [
        {
          name: "{{user}}",
          content: { text: `type '${letter}'` },
        },
        {
          name: "{{agent}}",
          content: {
            text: letter,
            actions: [`TYPE_${upper}`],
          },
        },
      ],
    ] as ActionExample[][],
  } as Action;
}

export const typewriterActions: Action[] = (
  "abcdefghijklmnopqrstuvwxyz".split("") as TypewriterLetter[]
).map(createLetterAction);


