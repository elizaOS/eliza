import * as path from "node:path";
import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { generateText, logger, ModelType } from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/specs";
import { createProseService, type ProseService } from "../services/proseService";
import type { ProseCompileResult } from "../types";

const spec = requireActionSpec("PROSE_COMPILE");

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

const EXTRACT_TEMPLATE = `<extraction_task>
Extract the prose file path from the user's message.

User message: {{content}}

Respond with ONLY this XML tag:
<file>path/to/program.prose</file>

If no file path is found, leave the tag empty.
</extraction_task>`;

const COMPILE_TEMPLATE = `You are the OpenProse compiler/validator. Analyze the following .prose program
for syntax errors, structural issues, and potential problems.

{{compiler_spec}}

═══════════════════════════════════════════════════════════════
                    PROGRAM TO VALIDATE
═══════════════════════════════════════════════════════════════

\`\`\`prose
{{program}}
\`\`\`

═══════════════════════════════════════════════════════════════
                    VALIDATION TASK
═══════════════════════════════════════════════════════════════

Analyze this program and report:
1. Whether the syntax is valid
2. Any structural errors (missing definitions, invalid references)
3. Warnings about potential issues or antipatterns
4. Suggestions for improvement

Respond with ONLY these XML tags:
<valid>true or false</valid>
<errors>
- error 1
- error 2
(or empty if no errors)
</errors>
<warnings>
- warning 1
- warning 2
(or empty if no warnings)
</warnings>
<summary>Brief summary of validation results</summary>`;

/**
 * Parse simple XML key-value pairs from text
 */
function parseKeyValueXml(text: string, keys: string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of keys) {
    const regex = new RegExp(`<${key}>([\\s\\S]*?)</${key}>`, "i");
    const match = text.match(regex);
    if (match?.[1]) {
      const value = match[1].trim();
      if (value) {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Parse a list from text (lines starting with -)
 */
function parseList(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.substring(1).trim())
    .filter((line) => line.length > 0);
}

export const proseCompileAction: Action = {
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

    // Match compile/validate commands
    if (lower.includes("prose compile")) return true;
    if (lower.includes("prose validate")) return true;
    if (lower.includes("check") && lower.includes(".prose")) return true;
    if (lower.includes("validate") && lower.includes(".prose")) return true;

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

    try {
      // Extract file path
      const extraction = await generateText({
        runtime,
        context: EXTRACT_TEMPLATE.replace("{{content}}", content),
        modelType: ModelType.TEXT_SMALL,
      });

      const params = parseKeyValueXml(extraction, ["file"]);

      if (!params.file) {
        if (callback) {
          callback({
            text: "Please specify a .prose file to validate. Example: `prose compile workflow.prose`",
            actions: [],
          });
        }
        return false;
      }

      const file = params.file;
      const filePath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);

      // Check if file exists
      const exists = await service.fileExists(filePath);
      if (!exists) {
        if (callback) {
          callback({
            text: `File not found: ${filePath}`,
            actions: [],
          });
        }
        return false;
      }

      // Read the program
      const programContent = await service.readProseFile(filePath);

      // Get compiler spec
      const compilerSpec =
        service.getCompilerSpec() ||
        "Validate the OpenProse program for syntax and structural correctness.";

      // Run validation
      const compilePrompt = COMPILE_TEMPLATE.replace("{{compiler_spec}}", compilerSpec).replace(
        "{{program}}",
        programContent
      );

      const validation = await generateText({
        runtime,
        context: compilePrompt,
        modelType: ModelType.TEXT_SMALL,
      });

      const result = parseKeyValueXml(validation, ["valid", "errors", "warnings", "summary"]);

      const isValid = result.valid?.toLowerCase() === "true";
      const errors = parseList(result.errors);
      const warnings = parseList(result.warnings);
      const summary = result.summary || "Validation complete.";

      logger.info(`[PROSE_COMPILE] Validated ${file}: valid=${isValid}`);

      // Build response
      const parts: string[] = [];
      parts.push(`## Validation Results for ${file}\n`);
      parts.push(`**Status:** ${isValid ? "✓ Valid" : "✗ Invalid"}\n`);
      parts.push(`**Summary:** ${summary}\n`);

      if (errors.length > 0) {
        parts.push("\n### Errors\n");
        for (const error of errors) {
          parts.push(`- ❌ ${error}`);
        }
      }

      if (warnings.length > 0) {
        parts.push("\n### Warnings\n");
        for (const warning of warnings) {
          parts.push(`- ⚠️ ${warning}`);
        }
      }

      if (isValid && errors.length === 0 && warnings.length === 0) {
        parts.push("\nNo issues found. Program is ready to run.");
      }

      if (callback) {
        callback({
          text: parts.join("\n"),
          actions: isValid ? ["PROSE_RUN"] : ["PROSE_COMPILE"],
          data: {
            valid: isValid,
            errors,
            warnings,
            file,
          },
        });
      }

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[PROSE_COMPILE] Error: ${errorMsg}`);

      if (callback) {
        callback({
          text: `Failed to validate program: ${errorMsg}`,
          actions: [],
        });
      }
      return false;
    }
  },
};
