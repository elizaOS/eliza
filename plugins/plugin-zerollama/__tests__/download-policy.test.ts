/** Exercises download policy over real loopback HTTP with a controlled protocol server, not a live model. */
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVisionProvider } from "../../../packages/agent/src/providers/media-provider";
import { ensureModelAvailable } from "../models/availability";

describe("explicit Ollama model installation", () => {
  const requests: string[] = [];
  let installed = false;
  let lookupStatus = 404;
  let baseURL = "";
  const server = createServer((request, response) => {
    const route = request.url;
    requests.push(`${request.method} ${route}`);
    response.setHeader("Content-Type", "application/json");
    if (route === "/api/show") {
      response.writeHead(installed ? 200 : lookupStatus);
      response.end(JSON.stringify(installed ? {} : { error: "missing" }));
    } else if (route === "/api/tags") {
      response.end(JSON.stringify({ models: installed ? [{ name: "llava:latest" }] : [] }));
    } else if (route === "/api/pull") {
      installed = true;
      response.end(JSON.stringify({ status: "success" }));
    } else if (route === "/api/chat") {
      response.end(JSON.stringify({ message: { content: "protocol test response" } }));
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    baseURL = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  it.each([404, 400, 401, 500])("fails lookup %s without requesting a download", async (status) => {
    requests.length = 0;
    installed = false;
    lookupStatus = status;
    await expect(ensureModelAvailable("llava", baseURL)).rejects.toMatchObject({
      code: status === 404 ? "OLLAMA_MODEL_NOT_INSTALLED" : "OLLAMA_MODEL_LOOKUP_FAILED",
    });
    expect(requests).toEqual(["POST /api/show"]);
    expect(installed).toBe(false);
  });

  it("accepts an installed model without a download", async () => {
    requests.length = 0;
    installed = true;
    await ensureModelAvailable("llava", `${baseURL}/api/`);
    expect(requests).toEqual(["POST /api/show"]);
  });

  it.each([undefined, false, true])(
    "vision autoDownload=%s requires explicit true",
    async (autoDownload) => {
      requests.length = 0;
      installed = false;
      const provider = createVisionProvider(
        {
          mode: "own-key",
          provider: "ollama",
          ollama: { baseUrl: baseURL, model: "llava", autoDownload },
        },
        {}
      );
      const result = await provider.analyze({ imageBase64: "dGVzdA==" });
      expect(result.success).toBe(autoDownload === true);
      expect(requests).toEqual(
        autoDownload === true
          ? ["GET /api/tags", "POST /api/pull", "POST /api/chat"]
          : ["GET /api/tags"]
      );
      if (autoDownload !== true) expect(result.error).toContain("not found");
    }
  );
});
