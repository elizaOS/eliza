import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  extractMethods,
  findCloudApiRoot,
  routePathFromSegments,
  walkRoutes,
} from "../scripts/route-discovery.mjs";
import { ElizaCloudClient } from "./client.js";
import { ELIZA_CLOUD_PUBLIC_ENDPOINTS } from "./public-routes.js";

async function discoverRouteKeys(): Promise<string[]> {
  const { cloudRoot, apiRoot } = await findCloudApiRoot(process.cwd());
  const routeFiles = await walkRoutes(apiRoot);
  const keys: string[] = [];

  for (const routeFile of routeFiles) {
    const source = await readFile(routeFile.fullPath, "utf8");
    const route = routePathFromSegments(routeFile.relativeSegments);

    for (const method of (await extractMethods(source, routeFile.fullPath, cloudRoot)).filter(
      (method) => method !== "OPTIONS" && method !== "HEAD",
    )) {
      keys.push(`${method} ${route}`);
    }
  }

  return keys.sort();
}

describe("generated API route SDK surface", () => {
  it("discovers Hono route methods from the declared router variable", async () => {
    await expect(
      extractMethods(
        `
        import { Hono } from "hono";

        const honoRouter = new Hono();
        honoRouter.get("/", () => new Response());
        honoRouter.post("/", () => new Response());

        const __hono_app = new Hono();
        __hono_app.patch("/", () => new Response());
        __hono_app.all("*", () => new Response());

        const notRouter = { get: () => null };
        notRouter.get();
        `,
        "/tmp/sdk-route-discovery.test.ts",
        process.cwd(),
      ),
    ).resolves.toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
  });

  it("has one generated SDK route for every API route method pair", async () => {
    const discovered = await discoverRouteKeys();
    const generated = Object.keys(ELIZA_CLOUD_PUBLIC_ENDPOINTS).sort();

    expect(generated).toEqual(discovered);
  });

  it("exposes callable JSON and raw methods for every generated route", () => {
    const client = new ElizaCloudClient();
    const routeClient = client.routes as unknown as Record<string, unknown>;

    for (const definition of Object.values(ELIZA_CLOUD_PUBLIC_ENDPOINTS)) {
      expect(typeof routeClient[definition.methodName]).toBe("function");
      expect(typeof routeClient[`${definition.methodName}Raw`]).toBe("function");
    }
  });

  it("builds encoded normal and catch-all path params", async () => {
    const requests: string[] = [];
    const client = new ElizaCloudClient({
      baseUrl: "http://cloud.test",
      fetchImpl: async (input, init) => {
        requests.push(`${init?.method ?? "GET"} ${String(input)}`);
        return Response.json({ success: true });
      },
    });

    await client.routes.call("GET /api/v1/agents/{agentId}/n8n/{path}", {
      pathParams: { agentId: "agent 1", path: "workflow/run" },
      query: { q: "hello world" },
    });

    expect(requests.at(-1)).toBe(
      "GET http://cloud.test/api/v1/agents/agent%201/n8n/workflow/run?q=hello+world",
    );

    await client.routes.call("GET /api/v1/agents/{agentId}/n8n/{path}", {
      pathParams: { agentId: "agent 1", path: ["workflow", "run next"] },
    });

    expect(requests.at(-1)).toBe(
      "GET http://cloud.test/api/v1/agents/agent%201/n8n/workflow/run%20next",
    );
  });

  it("throws a clear error when required path params are missing", () => {
    const client = new ElizaCloudClient({ baseUrl: "http://cloud.test" });

    expect(() =>
      client.routes.call("GET /api/v1/agents/{agentId}", {
        pathParams: {} as { agentId: string | number },
      }),
    ).toThrow('Missing path parameter "agentId"');
  });

  it("throws a clear error for unexpected and multi-segment normal path params", () => {
    const client = new ElizaCloudClient({ baseUrl: "http://cloud.test" });

    expect(() =>
      client.routes.call("GET /api/v1/models", {
        pathParams: { extra: "value" },
      } as never),
    ).toThrow('Unexpected path parameter "extra"');

    expect(() =>
      client.routes.call("GET /api/v1/agents/{agentId}", {
        pathParams: { agentId: ["agent", "1"] },
      } as never),
    ).toThrow('Path parameter "agentId"');
  });

  it("returns raw responses for raw calls and always-binary generated methods", async () => {
    const requests: string[] = [];
    const client = new ElizaCloudClient({
      baseUrl: "http://cloud.test",
      fetchImpl: async (input, init) => {
        requests.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new Response("audio-bytes", {
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    const raw = await client.routes.postApiV1VoiceTts({
      json: { text: "hello" },
    });

    expect(raw).toBeInstanceOf(Response);
    expect(await raw.text()).toBe("audio-bytes");
    expect(requests.at(-1)).toBe("POST http://cloud.test/api/v1/voice/tts");
  });
});
