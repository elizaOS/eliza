/** Builds bounded data fixtures for production scheduled-message body and title rendering. */

import type { ScenarioModelFixture } from "@elizaos/scenario-runner/schema";

function renderedBody(instruction: string): string {
  const ownerMessage = instruction
    .replace(/^remind the owner to\s+/i, "")
    .replace(/^ask the owner to\s+/i, "")
    .replace(/^tell the owner to\s+/i, "")
    .replace(/^gentle check-in:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const clamped =
    ownerMessage.length >= 64
      ? `${ownerMessage.slice(0, 60).trimEnd()}…`
      : ownerMessage;
  return ownerMessage ? `Heads up: ${clamped}` : "checking in.";
}

function renderedTitle(body: string): string {
  const words = body.split(/\s+/).filter(Boolean).slice(0, 6);
  return words.length > 0 ? words.join(" ") : "Reminder";
}

/** Declare the two visible model calls made for each scheduled dispatch. */
export function scheduledDispatchModelFixtures(
  instructions: readonly {
    name: string;
    instruction: string;
    cardinality?: number | { min?: number; max?: number };
    titleCardinality?: number | { min?: number; max?: number };
  }[],
): ScenarioModelFixture[] {
  return instructions.flatMap(
    ({
      name,
      instruction,
      cardinality = 1,
      titleCardinality = cardinality,
    }) => {
      const body = renderedBody(instruction);
      return [
        {
          name: `${name}-scheduled-body`,
          match: {
            modelType: ["TEXT_SMALL", "TEXT_LARGE"],
            prompt: {
              includes: `\nInstruction:\n${instruction}\n\nMessage:`,
            },
          },
          response: { text: body },
          cardinality,
        },
        {
          name: `${name}-scheduled-title`,
          match: {
            modelType: "TEXT_SMALL",
            prompt: { includes: `\nMessage body:\n${body}\n\nFired at:` },
          },
          response: { text: renderedTitle(body) },
          cardinality: titleCardinality,
        },
      ];
    },
  );
}
