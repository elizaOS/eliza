/**
 * Action specs for plugin-prose
 */

export interface ActionSpec {
  name: string;
  description: string;
  similes?: string[];
  examples?: Array<Array<{ role: string; content: string }>>;
}

export const actionSpecs: Record<string, ActionSpec> = {
  PROSE_RUN: {
    name: "PROSE_RUN",
    description:
      "Run an OpenProse program (.prose file). OpenProse is a programming language for AI sessions that orchestrates multi-agent workflows.",
    similes: ["RUN_PROSE", "EXECUTE_PROSE", "PROSE_EXECUTE", "RUN_WORKFLOW", "ORCHESTRATE"],
    examples: [
      [
        {
          role: "user",
          content: "Run the hello world prose program",
        },
        {
          role: "assistant",
          content: "Loading the OpenProse VM and executing hello-world.prose...",
        },
      ],
      [
        {
          role: "user",
          content: "prose run examples/37-the-forge.prose",
        },
        {
          role: "assistant",
          content:
            "Starting The Forge - this program will orchestrate building a web browser from scratch.",
        },
      ],
    ],
  },

  PROSE_COMPILE: {
    name: "PROSE_COMPILE",
    description: "Validate an OpenProse program without executing it. Checks syntax and structure.",
    similes: ["VALIDATE_PROSE", "CHECK_PROSE", "PROSE_VALIDATE", "PROSE_CHECK"],
    examples: [
      [
        {
          role: "user",
          content: "Check if my workflow.prose file is valid",
        },
        {
          role: "assistant",
          content: "Validating workflow.prose... The program is syntactically correct.",
        },
      ],
    ],
  },

  PROSE_HELP: {
    name: "PROSE_HELP",
    description:
      "Get help with OpenProse syntax, commands, and examples. Shows available programs and guidance.",
    similes: ["PROSE_EXAMPLES", "PROSE_SYNTAX", "PROSE_DOCS", "HELP_PROSE"],
    examples: [
      [
        {
          role: "user",
          content: "How do I write a prose program?",
        },
        {
          role: "assistant",
          content: "OpenProse programs use sessions to spawn AI agents. Here's the basic syntax...",
        },
      ],
    ],
  },
};

export function requireActionSpec(name: string): ActionSpec {
  const spec = actionSpecs[name];
  if (!spec) {
    throw new Error(`Action spec not found: ${name}`);
  }
  return spec;
}
