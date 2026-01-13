import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { CodeTask, JsonValue, TaskResult } from "../../types.js";
import type { SubAgent, SubAgentContext } from "./types.js";

interface CodexSdkModule {
  Codex: new () => {
    startThread: (options?: { workingDirectory?: string }) => {
      runStreamed: (
        prompt: string,
      ) => Promise<{ events: AsyncIterable<Record<string, JsonValue>> }>;
    };
  };
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, JsonValue>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function getObject(
  obj: Record<string, JsonValue>,
  key: string,
): Record<string, JsonValue> | null {
  const v = obj[key];
  return isRecord(v) ? v : null;
}

function getArray(
  obj: Record<string, JsonValue>,
  key: string,
): JsonValue[] | null {
  const v = obj[key];
  return Array.isArray(v) ? v : null;
}

/**
 * CodexSdkSubAgent
 *
 * Executes a task via the OpenAI Codex SDK `runStreamed()` interface, emitting
 * file-change events into the user log and returning a TaskResult summary.
 *
 * Tests should mock the SDK module; this implementation avoids doing any network
 * calls in unit tests.
 */
export class CodexSdkSubAgent implements SubAgent {
  readonly name = "Codex SDK Worker";
  readonly type = "codex" as const;

  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }

  async execute(task: CodeTask, context: SubAgentContext): Promise<TaskResult> {
    const { workingDirectory, onMessage, isCancelled } = context;

    const filesCreated: string[] = [];
    const filesModified: string[] = [];
    let finalResponse = "";

    let sdk: CodexSdkModule;
    try {
      sdk = (await import("@openai/codex-sdk")) as CodexSdkModule;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: "Codex SDK is not available",
        filesCreated,
        filesModified,
        error: message,
      };
    }

    if (this.cancelled || isCancelled()) {
      return {
        success: false,
        summary: "Cancelled",
        filesCreated,
        filesModified,
        error: "Cancelled",
      };
    }

    const codex = new sdk.Codex();
    const thread = codex.startThread({ workingDirectory });
    const prompt =
      `Task: ${task.name}\nWorking directory: ${workingDirectory}\n\n${task.description ?? ""}`.trim();

    try {
      const { events } = await thread.runStreamed(prompt);

      for await (const event of events) {
        if (this.cancelled || isCancelled()) {
          break;
        }
        if (!isRecord(event)) continue;

        const type = getString(event, "type") ?? "";

        if (type === "turn.failed") {
          const errObj = getObject(event, "error");
          const msg = errObj ? getString(errObj, "message") : null;
          const message = msg ?? "Turn failed";
          return {
            success: false,
            summary: `Codex failed: ${message}`,
            filesCreated,
            filesModified,
            error: message,
          };
        }

        if (type === "item.completed") {
          const item = getObject(event, "item");
          if (!item) continue;

          const itemType = getString(item, "type") ?? "";
          if (itemType === "agent_message") {
            const text = getString(item, "text") ?? "";
            if (text) finalResponse = text;
          }

          if (itemType === "fileChange" || itemType === "file_change") {
            const changes = getArray(item, "changes") ?? [];
            for (const ch of changes) {
              if (!isRecord(ch)) continue;
              const filepath = getString(ch, "path") ?? "";
              const kind = (getString(ch, "kind") ?? "").toLowerCase();
              if (!filepath) continue;

              if (kind === "create" || kind === "created" || kind === "add") {
                if (!filesCreated.includes(filepath))
                  filesCreated.push(filepath);
              } else {
                if (!filesModified.includes(filepath))
                  filesModified.push(filepath);
              }

              const abs = path.resolve(workingDirectory, filepath);
              const link = pathToFileURL(abs).toString();
              const action =
                kind === "create" || kind === "created" ? "write" : "edit";
              onMessage(`FILE ${action}: ${filepath} — ${link}`, "info");
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: `Codex SDK failed: ${message}`,
        filesCreated,
        filesModified,
        error: message,
      };
    }

    if (this.cancelled || isCancelled()) {
      return {
        success: false,
        summary: "Cancelled",
        filesCreated,
        filesModified,
        error: "Cancelled",
      };
    }

    const summary =
      finalResponse.trim().split("\n")[0] ||
      `Completed: ${task.name}`.substring(0, 120);

    return {
      success: true,
      summary,
      filesCreated,
      filesModified,
    };
  }
}
