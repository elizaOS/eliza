import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/specs";
import { type ProseService, createProseService } from "../services/proseService";

const spec = requireActionSpec("PROSE_HELP");

// Service cache
const serviceCache = new WeakMap<IAgentRuntime, ProseService>();

function getService(runtime: IAgentRuntime): ProseService {
  let service = serviceCache.get(runtime);
  if (!service) {
    service = createProseService(runtime, {});
    serviceCache.set(runtime, service);
  }
  return service;
}

const QUICK_REFERENCE = `# OpenProse Quick Reference

OpenProse is a programming language for AI sessions. Programs define agents and sessions
that coordinate multi-agent workflows.

## Basic Syntax

\`\`\`prose
# Program composition
program "name" version "1.0" {
    description "..."
    required_capabilities [capability1, capability2]
    
    define Agent researcher {
        system_prompt """..."""
        tools [browse, search]
    }
    
    session main(inputs) -> outputs {
        // Use agents to perform tasks
        result <- researcher.complete("Research this topic")
        return { summary: result }
    }
}
\`\`\`

## Commands

- \`prose run <file.prose>\` - Execute a program
- \`prose compile <file.prose>\` - Validate without running
- \`prose help\` - Show this help
- \`prose examples\` - List available examples

## Session Primitives

- \`agent.complete(prompt)\` - Run agent to completion
- \`agent.stream(prompt)\` - Stream agent response
- \`session.spawn(inputs)\` - Fork a subsession
- \`await session_ref\` - Wait for session result

## State Management

Programs can use different state backends:
- **filesystem** (default) - State stored in .prose/runs/
- **in-context** - State in conversation memory
- **sqlite** - SQLite database
- **postgres** - PostgreSQL database

## More Information

Use \`prose examples\` to see available example programs.
Each example demonstrates different OpenProse features.
`;

export const proseHelpAction: Action = {
  name: spec.name,
  description: spec.description,
  similes: spec.similes || [],
  examples: spec.examples
    ? spec.examples.map((ex) =>
        ex.map((msg) => ({
          name: msg.role,
          content: { text: msg.content },
        }))
      )
    : [],

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const content =
      typeof message.content === "string" ? message.content : message.content?.text || "";
    const lower = content.toLowerCase();

    // Match help-related commands
    if (lower.includes("prose help")) return true;
    if (lower.includes("prose examples")) return true;
    if (lower.includes("prose syntax")) return true;
    if (lower.includes("how do i write") && lower.includes("prose")) return true;
    if (lower.includes("what is openprose")) return true;
    if (lower.includes("openprose tutorial")) return true;

    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const service = getService(runtime);
    const content =
      typeof message.content === "string" ? message.content : message.content?.text || "";
    const lower = content.toLowerCase();

    try {
      const isExamplesRequest = lower.includes("examples");
      const isSyntaxRequest = lower.includes("syntax");
      const isGuidanceRequest =
        lower.includes("how do i write") ||
        lower.includes("tutorial") ||
        lower.includes("patterns");

      const parts: string[] = [];

      // Always include quick reference
      if (!isExamplesRequest) {
        // Get fuller help if available
        const help = service.getHelp();
        if (help && (isSyntaxRequest || isGuidanceRequest)) {
          parts.push(help);
        } else {
          parts.push(QUICK_REFERENCE);
        }
      }

      // Include authoring guidance if requested
      if (isGuidanceRequest) {
        const guidance = service.getAuthoringGuidance();
        if (guidance.patterns) {
          parts.push("\n## Authoring Patterns\n");
          parts.push(guidance.patterns);
        }
        if (guidance.antipatterns) {
          parts.push("\n## Antipatterns to Avoid\n");
          parts.push(guidance.antipatterns);
        }
      }

      // List examples
      if (isExamplesRequest) {
        parts.push("# Available OpenProse Examples\n");

        const examples = await service.listExamples();

        if (examples.length > 0) {
          parts.push("The following example programs are available:\n");
          for (const ex of examples) {
            parts.push(`- \`${ex}\``);
          }
          parts.push("\nRun an example with: `prose run examples/<name>`");
        } else {
          parts.push("No example programs found in the skills directory.");
          parts.push(
            "\nExamples should be placed in the `examples/` subdirectory of the prose skill."
          );
        }

        // Add some inline examples
        parts.push("\n## Example Programs\n");
        parts.push("Here are some example patterns you can use:\n");

        parts.push("### Hello World\n");
        parts.push(`\`\`\`prose
program "hello" version "1.0" {
    description "A simple hello world program"
    
    define Agent greeter {
        system_prompt "You are a friendly greeter."
    }
    
    session main() -> result {
        greeting <- greeter.complete("Say hello to the user")
        return { message: greeting }
    }
}
\`\`\`\n`);

        parts.push("### Multi-Agent Research\n");
        parts.push(`\`\`\`prose
program "research" version "1.0" {
    description "Multi-agent research workflow"
    required_capabilities [browse, search]
    
    define Agent researcher {
        system_prompt "You research topics thoroughly."
        tools [search, browse]
    }
    
    define Agent writer {
        system_prompt "You write clear summaries."
    }
    
    session main(topic: string) -> report {
        findings <- researcher.complete("Research: " + topic)
        summary <- writer.complete("Summarize: " + findings)
        return { topic: topic, summary: summary }
    }
}
\`\`\`\n`);
      }

      logger.info(`[PROSE_HELP] Provided help for: ${lower}`);

      if (callback) {
        callback({
          text: parts.join("\n"),
          actions: ["PROSE_RUN", "PROSE_COMPILE"],
        });
      }

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[PROSE_HELP] Error: ${errorMsg}`);

      if (callback) {
        callback({
          text: `Error retrieving help: ${errorMsg}`,
          actions: [],
        });
      }
      return false;
    }
  },
};
