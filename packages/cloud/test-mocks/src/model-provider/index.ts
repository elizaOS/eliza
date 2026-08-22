/** Starts and exports the resettable local model-provider protocol mock. */

import { startFetchServer } from "../fetch-server";
import { buildModelProviderMockFetch, ModelProviderMockStore } from "./server";
import type { ModelProviderSeed } from "./types";

export * from "./server";
export * from "./types";

export async function startModelProviderMock(options: {
  seed: ModelProviderSeed;
  port?: number;
  hostname?: string;
}) {
  const store = new ModelProviderMockStore(options.seed);
  const server = await startFetchServer(buildModelProviderMockFetch(store), {
    port: options.port,
    hostname: options.hostname,
  });
  const origin = `http://${server.hostname}:${server.port}`;
  return {
    origin,
    configuredEmbeddingBaseUrl: `${origin}/configured/v1`,
    googleBaseUrl: `${origin}/google`,
    ollamaBaseUrl: `${origin}/ollama`,
    zaiBaseUrl: `${origin}/zai`,
    store,
    stop: server.stop,
  };
}
