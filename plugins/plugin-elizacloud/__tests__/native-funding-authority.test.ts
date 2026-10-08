/** Exercises the actual Cloud handler, SDK HTTP and AgentRuntime fallback against a controlled local provider failure. */
import { createServer } from "node:http";
import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, test, vi } from "vitest";
import { handleTextLarge } from "../src/models/text";
import { handleCloudStatusRoutes } from "../src/routes/cloud-status-routes";
import { handleCloudStatusRoutes as handleAutonomousCloudStatusRoutes } from "../src/routes/cloud-status-routes-autonomous";

test.each([
  { name: "provider failure", admission: false, recover: false, attempts: 1 },
  { name: "recovered admission", admission: true, recover: true, attempts: 2 },
  { name: "exhausted admission", admission: true, recover: false, attempts: 5 },
])(
  "native product $name retains funding authority instead of using another payer",
  async ({ admission, recover, attempts }) => {
    const requests: Array<{
      slot: string | string[] | undefined;
      operation: string | string[] | undefined;
    }> = [];
    const server = createServer((request, response) => {
      requests.push({
        slot: request.headers["x-eliza-application-slot"],
        operation: request.headers["idempotency-key"],
      });
      request.resume();
      if (recover && requests.length > 1) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "admitted response" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      } else {
        response.writeHead(503, {
          "Content-Type": "application/json",
          ...(admission ? { "Retry-After": "1" } : {}),
        });
        response.end(
          JSON.stringify({
            error: admission
              ? {
                  message: "Inference admission is temporarily unavailable. Retry shortly.",
                  type: "service_unavailable",
                  code: "inference_admission_unavailable",
                }
              : { message: "upstream provider failed", type: "api_error", code: "provider_failed" },
          })
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local HTTP listener");
    try {
      const runtime = createSQLiteTestRuntime({
        character: { name: "Funded fixture", bio: "tests" },
        settings: {
          ELIZAOS_CLOUD_API_KEY: "eliza_controlled_native",
          ELIZAOS_CLOUD_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
          ELIZAOS_CLOUD_APPLICATION_SLOT: "fixture-product",
        },
        logLevel: "fatal",
      });
      const personalProvider = vi.fn(async () => "personal-funded response");
      runtime.registerModel(ModelType.TEXT_LARGE, handleTextLarge, "application-provider", 100);
      runtime.registerModel(ModelType.TEXT_LARGE, personalProvider, "personal-provider", 10);
      const invokeModel = runtime.useModel.bind(runtime);
      const result = invokeModel(ModelType.TEXT_LARGE, { prompt: "Complete original request" });
      if (recover) {
        await expect(result).resolves.toBe("admitted response");
      } else {
        await expect(result).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
      }
      expect(personalProvider).not.toHaveBeenCalled();
      expect(requests).toHaveLength(attempts);
      expect(requests[0]?.slot).toBe("fixture-product");
      expect(requests[0]?.operation).toEqual(expect.any(String));
      expect(requests.every((request) => request.slot === requests[0]?.slot)).toBe(true);
      expect(requests.every((request) => request.operation === requests[0]?.operation)).toBe(true);
      for (const handler of [handleCloudStatusRoutes, handleAutonomousCloudStatusRoutes]) {
        const json = vi.fn();
        await handler({
          req: {} as never,
          res: {} as never,
          method: "GET",
          pathname: "/api/cloud/status",
          config: {},
          runtime,
          json,
        });
        expect(json).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            applicationBilling: { kind: "configured", slotKey: requests[0]?.slot },
          })
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  },
  10_000
);
