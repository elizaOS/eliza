/**
 * Exercises response schemas through the real model handler, session, installed
 * Codex SDK and inference launcher. Only the executable is a local protocol
 * recorder; no model or account is contacted.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateTextParams, GenerateTextResult, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { __setCodexSdkSessionFactoryForTests, buildModels, disposeSdkSessions } from "../index";
import { CodexSdkSession } from "../src/codex-sdk-session";

describe("Codex SDK response schemas at the subprocess boundary", () => {
  it.each(["TEXT_LARGE", "RESPONSE_HANDLER"] as const)(
    "forwards complete per-request schemas through %s without retaining a prior schema",
    async (modelType) => {
      const directory = await mkdtemp(join(tmpdir(), "codex-schema-contract-"));
      const receipt = join(directory, "requests.jsonl");
      const probe = join(directory, "probe.mjs");
      const restore = __setCodexSdkSessionFactoryForTests(
        (config) => new CodexSdkSession({ ...config, codexBinPath: probe })
      );
      try {
        await writeFile(
          probe,
          `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
const schemaIndex = args.indexOf("--output-schema");
const schema = schemaIndex < 0 ? null : JSON.parse(readFileSync(args[schemaIndex + 1], "utf8"));
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ input, schema }) + "\\n");
for (const event of [
  {type:"thread.started",thread_id:"schema-probe"},
  {type:"item.completed",item:{id:"reply",type:"agent_message",text:"protocol complete"}},
  {type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}
]) process.stdout.write(JSON.stringify(event) + "\\n");
`
        );
        await chmod(probe, 0o700);
        const models = buildModels({
          ELIZA_CHAT_VIA_CLI: "codex-sdk",
          ELIZA_PLANNER_NATIVE_TOOLS: "1",
        });
        const handler = models?.[modelType] as (
          runtime: IAgentRuntime,
          params: GenerateTextParams
        ) => Promise<string | GenerateTextResult>;
        const runtime = {
          getSetting: (key: string) =>
            key === "ELIZA_CHAT_VIA_CLI"
              ? "codex-sdk"
              : key === "ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION"
                ? "0"
                : undefined,
        } as IAgentRuntime;
        const description = "完整 schema 🧭 ".repeat(2000);
        const schema: NonNullable<GenerateTextParams["responseSchema"]> = {
          type: "object",
          properties: {
            messageToUser: { type: "string", description },
            decision: {
              type: "object",
              properties: { done: { type: "boolean" } },
              required: ["done"],
              additionalProperties: false,
            },
          },
          required: ["messageToUser", "decision"],
          additionalProperties: false,
        };
        const nextSchema: NonNullable<GenerateTextParams["responseSchema"]> = {
          type: "object",
          properties: { answer: { type: "integer" } },
          required: ["answer"],
          additionalProperties: false,
        };
        const prompt = "Preserve every evaluator input 🧭\n".repeat(2000);
        for (const responseSchema of [schema, nextSchema, undefined]) {
          expect(
            await handler(runtime, {
              system: "Evaluate the complete turn.",
              prompt,
              responseSchema,
            })
          ).toBe("protocol complete");
        }
        const requests: Array<{ input: string; schema: object | null }> = (
          await readFile(receipt, "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests.map((request) => request.schema)).toEqual([schema, nextSchema, null]);
        for (const request of requests) {
          expect(request.input).toContain(prompt);
          expect(request.input).toContain("Evaluate the complete turn.");
        }
      } finally {
        restore();
        await disposeSdkSessions();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
