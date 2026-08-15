/**
 * Proves the production Shared adapter, real AgentRuntime, core reply loop, and
 * native model tool contract together inside a real Workerd isolate.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

describe("Shared Eliza runtime in Workerd", () => {
  let buildDirectory: string;
  let miniflare: Miniflare;
  let modelServer: ReturnType<typeof Bun.serve>;
  const modelRequests: Array<Record<string, unknown>> = [];
  const outboundRequests: string[] = [];
  let searchPlannerRequests = 0;
  const liveModelUrl = process.env.SHARED_ELIZA_LIVE_MODEL_URL?.replace(
    /\/+$/,
    "",
  );
  const liveModelId = process.env.SHARED_ELIZA_LIVE_MODEL_ID;

  beforeAll(async () => {
    modelServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        modelRequests.push(body);
        if (JSON.stringify(body).includes("latest ElizaOS release")) {
          searchPlannerRequests += 1;
          if (searchPlannerRequests === 1) {
            return Response.json({
              id: "chatcmpl-workerd-search-stage-one",
              object: "chat.completion",
              created: 0,
              model: "shared-runtime-probe",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "workerd-search-stage-one",
                        type: "function",
                        function: {
                          name: "HANDLE_RESPONSE",
                          arguments: JSON.stringify({
                            shouldRespond: "RESPOND",
                            contexts: ["web"],
                            intents: [],
                            candidateActionNames: ["WEB_SEARCH"],
                            requiresTool: true,
                            replyText: "",
                            replyEffectStatus: "none",
                            facts: [],
                            relationships: [],
                            addressedTo: [],
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: {
                prompt_tokens: 30,
                completion_tokens: 12,
                total_tokens: 42,
              },
            });
          }
          if (searchPlannerRequests === 2) {
            return Response.json({
              id: "chatcmpl-workerd-search-plan",
              object: "chat.completion",
              created: 0,
              model: "shared-runtime-probe",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "workerd-search-action",
                        type: "function",
                        function: {
                          name: "WEB_SEARCH",
                          arguments: JSON.stringify({
                            query: "latest ElizaOS release",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: {
                prompt_tokens: 40,
                completion_tokens: 10,
                total_tokens: 50,
              },
            });
          }
          return Response.json({
            id: "chatcmpl-workerd-search-finish",
            object: "chat.completion",
            created: 0,
            model: "shared-runtime-probe",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    success: true,
                    decision: "FINISH",
                    thought: "Answer from the public web result.",
                    messageToUser:
                      "I found the latest ElizaOS release through the live public search plugin.",
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 14,
              total_tokens: 64,
            },
          });
        }
        if (liveModelUrl && liveModelId) {
          return await fetch(`${liveModelUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, model: liveModelId }),
          });
        }
        return Response.json({
          id: "chatcmpl-workerd-shared-runtime",
          object: "chat.completion",
          created: 0,
          model: "shared-runtime-probe",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "workerd-handle-response",
                    type: "function",
                    function: {
                      name: "HANDLE_RESPONSE",
                      arguments: JSON.stringify({
                        contexts: ["simple"],
                        intents: [],
                        replyText:
                          "hello through the production Workerd adapter",
                        replyEffectStatus: "none",
                        candidateActionNames: [],
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 51,
            completion_tokens: 19,
            total_tokens: 70,
          },
        });
      },
    });

    buildDirectory = await mkdtemp(join(tmpdir(), "shared-eliza-workerd-"));
    const coreDirectory = fileURLToPath(
      new URL("../../../core/", import.meta.url),
    );
    const coreBuild = Bun.spawn({
      cmd: [process.execPath, "build.ts", "--edge-only"],
      cwd: coreDirectory,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [coreBuildExitCode, coreBuildStderr] = await Promise.all([
      coreBuild.exited,
      new Response(coreBuild.stderr).text(),
    ]);
    if (coreBuildExitCode !== 0) {
      throw new Error(
        `Failed to build @elizaos/core/edge:\n${coreBuildStderr}`,
      );
    }

    const entrypoint = fileURLToPath(
      new URL(
        "../test/fixtures/shared-eliza-runtime-worker.ts",
        import.meta.url,
      ),
    );
    const outputPath = join(buildDirectory, "worker.mjs");
    const repositoryDirectory = fileURLToPath(
      new URL("../../../../", import.meta.url),
    );
    const coreEdgeArtifact = join(coreDirectory, "dist/edge/index.edge.js");
    const bundle = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const result = await Bun.build({
          entrypoints: [process.env.SHARED_ELIZA_ENTRY],
          target: "browser",
          format: "esm",
          conditions: ["worker"],
          external: ["node:*"],
          plugins: [{
            name: "eliza-core-edge-boundary",
            setup(build) {
              build.onResolve({ filter: /^@elizaos\\/core\\/edge$/ }, () => ({
                path: process.env.ELIZA_CORE_EDGE_ARTIFACT,
              }));
            },
          }],
        });
        if (!result.success) {
          for (const log of result.logs) console.error(log);
          process.exit(1);
        }
        const output = result.outputs[0];
        if (!output) throw new Error("Shared Eliza runtime bundle was not emitted");
        await Bun.write(process.env.SHARED_ELIZA_OUTPUT, output);`,
      ],
      cwd: repositoryDirectory,
      env: {
        ...process.env,
        ELIZA_CORE_EDGE_ARTIFACT: coreEdgeArtifact,
        SHARED_ELIZA_ENTRY: entrypoint,
        SHARED_ELIZA_OUTPUT: outputPath,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [bundleExitCode, bundleStderr] = await Promise.all([
      bundle.exited,
      new Response(bundle.stderr).text(),
    ]);
    if (bundleExitCode !== 0) {
      throw new Error(`Failed to bundle Shared Eliza runtime: ${bundleStderr}`);
    }

    miniflare = new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      outboundService: async (request: Request) => {
        outboundRequests.push(request.url);
        return await fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: await request.arrayBuffer() }),
        });
      },
      bindings: {
        NODE_ENV: "production",
        OPENROUTER_API_KEY: "workerd-shared-runtime-key",
        OPENROUTER_BASE_URL: `http://127.0.0.1:${modelServer.port}/v1`,
      },
      modules: [
        {
          type: "ESModule",
          path: "worker.mjs",
          contents: await readFile(outputPath, "utf8"),
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await miniflare?.dispose();
    modelServer?.stop(true);
    if (buildDirectory) await rm(buildDirectory, { recursive: true });
  });

  test("runs the production Shared adapter through the genuine runtime", async () => {
    const response = await miniflare.dispatchFetch("https://runtime.test/");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      reply: string;
      model: string;
      degraded: boolean;
      usage?: Record<string, number>;
    };
    expect(result).toMatchObject({
      model: "local/shared-runtime-probe",
      degraded: false,
    });
    if (liveModelUrl && liveModelId) {
      expect(result.reply.length).toBeGreaterThan(0);
      expect(result.reply).not.toContain("runtime step failed");
      console.info(
        JSON.stringify({
          liveModelId,
          reply: result.reply,
          usage: result.usage,
          providerCalls: modelRequests.length,
        }),
      );
    } else {
      expect(result).toMatchObject({
        reply: "hello through the production Workerd adapter",
        usage: {
          promptTokens: 51,
          completionTokens: 19,
          totalTokens: 70,
        },
      });
    }
    expect(modelRequests).toHaveLength(1);
    expect(
      (modelRequests[0].tools as Array<{ function?: { name?: string } }>).some(
        (tool) => tool.function?.name === "HANDLE_RESPONSE",
      ),
    ).toBe(true);
  }, 120_000);

  test.skipIf(process.env.SHARED_ELIZA_LIVE_WEB_SEARCH !== "1")(
    "plans and runs the genuine edge search plugin inside Workerd",
    async () => {
      const response = await miniflare.dispatchFetch(
        "https://runtime.test/search-turn",
      );
      const body = await response.text();
      expect(outboundRequests, body).toContain(
        "https://search.parallel.ai/mcp",
      );
      expect(response.status, body).toBe(200);
      const result = JSON.parse(body) as {
        reply: string;
        degraded: boolean;
        usage?: { totalTokens?: number };
      };
      expect(result).toMatchObject({
        reply:
          "I found the latest ElizaOS release through the live public search plugin.",
        degraded: false,
        usage: { totalTokens: 156 },
      });
      expect(searchPlannerRequests).toBe(3);
      expect(modelRequests).toHaveLength(4);
    },
    120_000,
  );
});
