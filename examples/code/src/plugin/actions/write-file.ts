import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { CODE_GENERATION_SYSTEM_PROMPT } from "../../lib/prompts.js";
import { getCwd } from "../providers/cwd.js";

function extractWriteParams(text: string): {
  filepath: string;
  content: string;
} {
  let filepath = "";

  const pathPatterns = [
    /\bat\s+["']?([./\w-]+\.[a-zA-Z0-9]+)["']?/i,
    /\bto\s+["']?([./\w-]+\.[a-zA-Z0-9]+)["']?/i,
    /(?:called|named)\s+["']?([./\w-]+\.[a-zA-Z0-9]+)["']?/i,
    /\bfile[:\s]+["']?([./\w-]+\.[a-zA-Z0-9]+)["']?/i,
    /(?:write|create|save)\s+(?:to\s+)?(?:a\s+)?(?:new\s+)?(?:file\s+)?["']?([./\w-]+\.[a-zA-Z0-9]+)["']?/i,
    /["'`]([./\w-]+\.[a-zA-Z0-9]+)["'`]/,
    /\b([a-zA-Z][\w-]*\.(?:js|ts|tsx|jsx|py|html|css|json|md|txt|sh|yaml|yml))\b/,
  ];

  for (const pattern of pathPatterns) {
    const match = text.match(pattern);
    if (
      match?.[1] &&
      !["a", "the", "an", "to", "at", "in"].includes(match[1].toLowerCase())
    ) {
      filepath = match[1];
      break;
    }
  }

  const codeBlockMatch = text.match(/```[\w]*\n?([\s\S]*?)```/);
  const content = codeBlockMatch?.[1]?.trim() ?? "";

  return { filepath, content };
}

export const writeFileAction: Action = {
  name: "WRITE_FILE",
  similes: ["CREATE_FILE", "SAVE_FILE", "NEW_FILE"],
  description: `Create a new file or overwrite an existing file, optionally generating content via LLM.

USE THIS ACTION WHEN:
- User says "write", "create", "save", "new file", or "build" with a file path
- User provides a specific filename with extension (e.g., "tetris.html", "utils.py")
- User wants a complete file generated and saved
- User provides content in code blocks to save to a file

DO NOT USE WHEN:
- User wants to modify existing content (use EDIT_FILE for targeted changes)
- User wants code displayed but not saved (use GENERATE)
- User describes a complex multi-file feature (use CREATE_TASK)
- No file path or file type can be determined

CONTENT HANDLING:
- If user provides content in code blocks, that content is used
- If no content provided, LLM generates appropriate content based on request
- Cleans up markdown fences from generated content

FILE PATH HANDLING:
- Explicit paths used directly: "create utils.ts" → utils.ts
- Inferred from context: "create a README" → README.md
- Auto-increments if inferred path exists: index.html → index-1.html

SAFETY:
- Creates parent directories automatically
- Warns when overwriting existing files (unless path was inferred)`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    // Check for file creation intent AND either an explicit path or strong file hints.
    const hasIntent =
      text.includes("write") ||
      text.includes("create") ||
      text.includes("save") ||
      text.includes("new file") ||
      text.includes("build");

    const hasExplicitPath = /\.[a-zA-Z0-9]+\b/.test(text); // Has a file extension
    const hasFileHint =
      text.includes("file") ||
      text.includes("readme") ||
      text.includes("markdown") ||
      text.includes("html") ||
      text.includes("json") ||
      text.includes("yaml") ||
      text.includes("yml");

    return hasIntent && (hasExplicitPath || hasFileHint);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content.text ?? "";
    let { filepath, content } = extractWriteParams(text);
    let inferredPath = false;

    if (!content && state?.pendingWrite) {
      const pending = state.pendingWrite as {
        filepath?: string;
        content?: string;
      };
      filepath = filepath || pending.filepath || "";
      content = pending.content || "";
    }

    if (!filepath) {
      const inferred = inferFilepath(text);
      if (!inferred) {
        const msg = "Could not determine file path.";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }
      filepath = inferred;
      inferredPath = true;
      await callback?.({
        text: `No file path provided — inferred: ${filepath}`,
      });
    }

    // If no content provided, generate it using the LLM
    if (!content) {
      await callback?.({ text: `Generating content for ${filepath}...` });

      try {
        const prompt = `${CODE_GENERATION_SYSTEM_PROMPT}

Request: ${text}

Generate the complete content for the file "${filepath}". 
Output ONLY the file content, no explanations, no markdown code fences, no additional text.
The content should be production-ready and complete.`;

        const result = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
          maxTokens: 8000,
          temperature: 0.3,
        });

        const generated =
          typeof result === "string"
            ? result.trim()
            : ((result as { text?: string })?.text?.trim() ?? "");

        if (!generated) {
          const msg = "Failed to generate content for the file.";
          await callback?.({ text: msg });
          return { success: false, text: msg };
        }

        // Clean up any markdown code fences the model might have added
        content = generated
          .replace(/^```[\w]*\n?/, "")
          .replace(/\n?```$/, "")
          .trim();

        logger.info(`Generated ${content.length} chars for ${filepath}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error(`WRITE_FILE generation error: ${error}`);
        await callback?.({ text: `Failed to generate content: ${error}` });
        return { success: false, text: error };
      }
    }

    const cwd = getCwd();
    let finalFilepath = filepath;
    let fullPath = path.resolve(cwd, finalFilepath);

    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      let isNew = true;
      try {
        await fs.access(fullPath);
        isNew = false;
      } catch {
        // File doesn't exist
      }

      // If we inferred the path and it already exists, avoid overwriting by picking a new filename.
      if (inferredPath && !isNew) {
        const next = await findAvailableFilename(cwd, finalFilepath);
        if (next) {
          finalFilepath = next;
          fullPath = path.resolve(cwd, finalFilepath);
          isNew = true;
        }
      }

      await fs.writeFile(fullPath, content, "utf-8");

      const action = isNew ? "Created" : "Overwrote";
      const note = inferredPath ? ` (inferred from request)` : "";
      const result = `${action} file: ${finalFilepath}${note} (${content.length} chars)`;

      await callback?.({ text: result });
      return {
        success: true,
        text: result,
        data: { filepath: finalFilepath, isNew, size: content.length },
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      const msg =
        error.code === "EACCES"
          ? `Permission denied: ${filepath}`
          : `Error: ${error.message}`;
      logger.error(`WRITE_FILE error: ${error.message}`);
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "create hello.txt with 'Hello World'" },
      },
      {
        name: "{{agent}}",
        content: { text: "Creating hello.txt...", actions: ["WRITE_FILE"] },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "build me a tetris game in tetris.html" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Generating content for tetris.html...",
          actions: ["WRITE_FILE"],
        },
      },
    ],
  ],
};

function inferFilepath(text: string): string | null {
  const lower = text.toLowerCase();

  if (lower.includes("readme")) return "README.md";

  // Infer extension from hints
  let ext = "txt";
  if (
    /\bhtml\b/.test(lower) ||
    lower.includes("webpage") ||
    lower.includes("website")
  )
    ext = "html";
  else if (/\bjson\b/.test(lower)) ext = "json";
  else if (/\bya?ml\b/.test(lower)) ext = "yml";
  else if (/\btypescript\b/.test(lower) || /\bts\b/.test(lower)) ext = "ts";
  else if (/\bjavascript\b/.test(lower) || /\bjs\b/.test(lower)) ext = "js";
  else if (/\bpython\b/.test(lower) || /\bpy\b/.test(lower)) ext = "py";

  // Infer base name from request
  const match = lower.match(
    /(?:build|create|write|make|save)\s+(?:me\s+)?(?:a|an|the)?\s*([a-z0-9][\w-]*)/i,
  );
  const baseRaw = match?.[1] ?? "index";
  const base = baseRaw.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "index";

  return `${base}.${ext}`;
}

async function findAvailableFilename(
  cwd: string,
  filepath: string,
): Promise<string | null> {
  const ext = path.extname(filepath);
  const base = ext ? filepath.slice(0, -ext.length) : filepath;

  for (let i = 1; i <= 50; i++) {
    const candidate = `${base}-${i}${ext}`;
    const full = path.resolve(cwd, candidate);
    try {
      await fs.access(full);
      // exists -> try next
    } catch {
      return candidate;
    }
  }
  return null;
}
