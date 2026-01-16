import { ClaudeAgentSdkSubAgent } from "./claude-agent-sdk-sub-agent.js";
import { CodexSdkSubAgent } from "./codex-sdk-sub-agent.js";
import { ElizaSubAgent } from "./eliza-sub-agent.js";
import { ElizaOSNativeSubAgent } from "./elizaos-native-sub-agent.js";
import { OpenCodeSubAgent } from "./opencode-sub-agent.js";
import { SweAgentSubAgent } from "./sweagent-sub-agent.js";
import type { SubAgent } from "./types.js";

const CLAUDE_CODE_PROMPT_TEMPLATE = `You are a Claude Code–style coding worker. Execute tasks using these tools:

AVAILABLE TOOLS:
1. TOOL: read_file(filepath="path/to/file")
2. TOOL: list_files(path="directory")
3. TOOL: search_files(pattern="text", path="directory", max_matches="50")
4. TOOL: shell(command="your command")
5. TOOL: edit_file(filepath="file", old_str="find this", new_str="replace with")
6. TOOL: write_file(filepath="path/to/file")
   CONTENT_START
   file content here
   CONTENT_END

RULES:
- Think in steps, but do not print long reasoning; focus on actions and results.
- Prefer search_files to locate definitions/usages quickly.
- For write_file: Use CONTENT_START and CONTENT_END markers.
- Write COMPLETE code - never truncate or use placeholders.
- Say "DONE: summary" when finished.

Working directory: {cwd}`;

const CODEX_PROMPT_TEMPLATE = `You are a Codex-style coding worker. Use tools to implement the task.

AVAILABLE TOOLS:
1. TOOL: read_file(filepath="path/to/file")
2. TOOL: list_files(path="directory")
3. TOOL: search_files(pattern="text", path="directory", max_matches="50")
4. TOOL: shell(command="your command")
5. TOOL: edit_file(filepath="file", old_str="find this", new_str="replace with")
6. TOOL: write_file(filepath="path/to/file")
   CONTENT_START
   file content here
   CONTENT_END

RULES:
- Call tools as needed; wait for results; iterate.
- Prefer small, correct diffs over speculative large rewrites.
- Say "DONE: summary" when finished.

Working directory: {cwd}`;

function normalizeType(type: SubAgent["type"]): SubAgent["type"] {
  return type === "claude" ? "claude-code" : type;
}

export function createSubAgent(type: SubAgent["type"]): SubAgent {
  const useSdkWorkers = process.env.ELIZA_CODE_USE_SDK_WORKERS !== "0";
  switch (normalizeType(type)) {
    case "eliza":
      return new ElizaSubAgent({
        name: "Eliza Worker",
        type: "eliza",
      });
    case "claude-code":
      return useSdkWorkers
        ? new ClaudeAgentSdkSubAgent()
        : new ElizaSubAgent({
            name: "Claude Code Worker",
            type: "claude-code",
            systemPromptTemplate: CLAUDE_CODE_PROMPT_TEMPLATE,
          });
    case "codex":
      return useSdkWorkers
        ? new CodexSdkSubAgent()
        : new ElizaSubAgent({
            name: "Codex Worker",
            type: "codex",
            systemPromptTemplate: CODEX_PROMPT_TEMPLATE,
          });
    case "opencode":
      return new OpenCodeSubAgent();
    case "sweagent":
      return new SweAgentSubAgent();
    case "elizaos-native":
      return new ElizaOSNativeSubAgent();
    default:
      return new ElizaSubAgent({
        name: "Eliza Worker",
        type: "eliza",
      });
  }
}
