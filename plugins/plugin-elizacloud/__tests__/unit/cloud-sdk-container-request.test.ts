import { type CreateContainerRequest, ElizaCloudClient } from "@elizaos/cloud-sdk";
import { describe, expect, it } from "vitest";

/**
 * De-vendor regression guard (Apps / Product 2).
 *
 * `plugin-elizacloud` used to carry a VENDORED copy of the cloud SDK under
 * `src/utils/cloud-sdk/` whose `CreateContainerRequest` was the OLD snake_case
 * shape (`project_name`, `environment_vars`, ...). The server's
 * `CreateContainerSchema` is camelCase, so a snake_case body had its
 * `environmentVars` (and the `ELIZA_APP_ID` riding inside it — the per-app
 * monetization attribution key) silently stripped by the zod parse.
 *
 * The vendored copy is deleted; the plugin now depends on the canonical
 * `@elizaos/cloud-sdk` (already a `workspace:*` dependency, already imported by
 * `utils/cloud-api.ts` / `utils/sdk-client.ts`). This test pins the plugin's
 * resolved SDK to the camelCase contract: if anyone re-vendors or re-points the
 * plugin at a stale snake_case SDK, both the compile-time type usage below and
 * the wire assertions fail.
 *
 * Mirrors `packages/cloud/sdk/src/client.test.ts` ("createContainer wire
 * contract") but exercises the type/method exactly as the plugin imports them.
 */

type RecordedRequest = {
  url: string;
  method: string;
  body?: unknown;
};

function createClientRecorder(responseBody: Record<string, unknown> = { success: true }) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input, init = {}) => {
    requests.push({
      url: String(input),
      method: init.method ?? "GET",
      body:
        typeof init.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    requests,
    client: new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_test_key",
      fetchImpl,
    }),
  };
}

describe("plugin-elizacloud → @elizaos/cloud-sdk createContainer (de-vendored)", () => {
  it("serializes a camelCase body so environmentVars.ELIZA_APP_ID survives the wire", async () => {
    const { client, requests } = createClientRecorder({ success: true, data: { id: "c_1" } });

    // Typed against the canonical CreateContainerRequest the plugin imports.
    // This object ONLY compiles while the SDK type is camelCase — a revert to
    // the vendored snake_case shape breaks the build right here.
    const request: CreateContainerRequest = {
      name: "Monetized App",
      image: "ghcr.io/elizaos/example-edad:showcase",
      projectName: "monetized-app",
      port: 3000,
      cpu: 256,
      memoryMb: 512,
      environmentVars: { ELIZA_APP_ID: "app_abc123", PORT: "3000" },
      healthCheckPath: "/health",
    };

    await client.createContainer(request);

    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/containers",
      method: "POST",
    });

    const body = requests[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "Monetized App",
      image: "ghcr.io/elizaos/example-edad:showcase",
      projectName: "monetized-app",
      port: 3000,
      cpu: 256,
      memoryMb: 512,
      healthCheckPath: "/health",
    });

    // The whole point of the casing fix: ELIZA_APP_ID rides through
    // environmentVars and reaches the wire. The vendored snake_case copy dropped it.
    expect((body.environmentVars as Record<string, string>).ELIZA_APP_ID).toBe("app_abc123");

    // Regression guard: none of the legacy snake_case keys the server zod
    // silently stripped may appear on the wire.
    for (const dropped of [
      "project_name",
      "environment_vars",
      "health_check_path",
      "memory",
      "desired_count",
    ]) {
      expect(body).not.toHaveProperty(dropped);
    }
  });
});
