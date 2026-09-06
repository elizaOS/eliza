/** Exercises the actual Cloud handler, SDK HTTP and AgentRuntime fallback against a controlled local provider failure. */
import { createServer } from "node:http";
import { AgentRuntime, InMemoryDatabaseAdapter, ModelType } from "@elizaos/core";
import { expect, test, vi } from "vitest";
import { handleTextLarge } from "../src/models/text";
import { handleCloudStatusRoutes } from "../src/routes/cloud-status-routes";
import { handleCloudStatusRoutes as handleAutonomousCloudStatusRoutes } from "../src/routes/cloud-status-routes-autonomous";

test("a native product provider failure retains funding authority instead of using another payer", async () => {
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
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "upstream provider failed", type: "api_error", code: "provider_failed" },
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local HTTP listener");
  try {
    const runtime = new AgentRuntime({
      character: { name: "Funded fixture", bio: "tests" },
      adapter: new InMemoryDatabaseAdapter(),
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
    await expect(
      invokeModel(ModelType.TEXT_LARGE, { prompt: "Complete original request" })
    ).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
    expect(personalProvider).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.slot).toBe("fixture-product");
    expect(requests[0]?.operation).toEqual(expect.any(String));
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
});
