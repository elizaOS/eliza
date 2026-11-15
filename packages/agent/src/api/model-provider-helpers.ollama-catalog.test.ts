import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchOllamaModels,
  ModelCatalogFetchError,
} from "./model-provider-helpers.ts";

/**
 * `fetchOllamaModels` is the only catalog fetch in this module that answered a
 * non-OK upstream status with `[]`. Every sibling (anthropic, google-genai,
 * nearai, fetchModelsREST) throws `ModelCatalogFetchError`, and the module's
 * own error policy at those catch blocks states that "a provider that answered
 * with an error status stays a typed catalog failure for the HTTP boundary
 * (models-routes.ts)". A configured-but-broken Ollama endpoint therefore
 * reported "no models installed" instead of "the catalog could not be read".
 *
 * Both cases drive the real `fetch` against a real loopback listener so the
 * behaviour under test is the one the shipped process exhibits, not a stubbed
 * `fetch` that can drift from it.
 */
const servers: Server[] = [];

/** Bind a listener on an ephemeral port; `handler` decides the response. */
async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("fetchOllamaModels catalog status", () => {
  it("rejects with ModelCatalogFetchError when the endpoint answers a non-OK status", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("model runner crashed");
    });

    await expect(fetchOllamaModels(baseUrl)).rejects.toBeInstanceOf(
      ModelCatalogFetchError,
    );
  });

  it("rejects with ModelCatalogFetchError when a 200 response body is not JSON", async () => {
    // A proxy in front of Ollama often answers 200 with its own login page.
    // The endpoint is reachable, so this must not be reported as "no models".
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>proxy login page</html>");
    });

    const rejection = await fetchOllamaModels(baseUrl).then(
      () => null,
      (e: unknown) => e,
    );

    expect(rejection).toBeInstanceOf(ModelCatalogFetchError);
    expect((rejection as ModelCatalogFetchError).upstreamStatus).toBe(200);
    expect((rejection as ModelCatalogFetchError).cause).toBeInstanceOf(
      SyntaxError,
    );
  });

  it("keeps a reachable endpoint with no models installed as an empty catalog", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
    });

    await expect(fetchOllamaModels(baseUrl)).resolves.toEqual([]);
  });

  it.each([
    null,
    {},
    { models: {} },
    { models: [null] },
    { models: [{}] },
    { models: [{ name: " " }] },
  ])("rejects a reachable malformed catalog: %j", async (payload) => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    await expect(fetchOllamaModels(baseUrl)).rejects.toMatchObject({
      code: "MODEL_CATALOG_FETCH_FAILED",
      providerId: "ollama",
      upstreamStatus: 200,
    });
  });

  it("returns valid model names from the same HTTP catalog", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
    });
    await expect(fetchOllamaModels(baseUrl)).resolves.toEqual([
      expect.objectContaining({ id: "qwen3:8b", name: "qwen3:8b" }),
    ]);
  });

  it("keeps an unreachable localhost probe as an explicit empty catalog", async () => {
    // Bind then release a port so the connection is refused, which is the
    // shipped "Ollama is not installed" case rather than an error status.
    const baseUrl = await listen(() => {});
    const port = new URL(baseUrl).port;
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    await expect(
      fetchOllamaModels(`http://127.0.0.1:${port}`),
    ).resolves.toEqual([]);
  });
});
