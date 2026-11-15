/** Small-model fallback chain, checked on the real TEXT_SMALL request path.

Drives `handleTextSmall` against a loopback Cloud endpoint and reads the
`model` field the request actually carries, so the whole chain is covered:
runtime settings -> `getSmallModel` -> `/responses` request body. A blank
`SMALL_MODEL` must fall through to the default instead of reaching the wire
as an invalid name, and an explicit nonblank model must be sent unchanged.
An explicitly blank model from the sealed launcher is the exception: it
must reach the prepared guard and fail loudly, with no request on the wire.

The runtime here is only a settings + character harness: the handler, the
SDK client, and the HTTP transport are the real code. (The repo's SQLite
test runtime pulls in `@elizaos/contracts/node`, whose source import needs a
built contracts `dist` in this checkout.)
*/

import { createServer } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "../src/cloud-config/dev-cloud-env-authority";
import { handleTextSmall } from "../src/models/text";

const DEFAULT_SMALL_MODEL = "qwen-3.8-27b";

const sealedKeys = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_SMALL_MODEL",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of sealedKeys) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of sealedKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function stubRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? undefined,
    character: { name: "Small model fixture", bio: ["tests"] },
  } as unknown as IAgentRuntime;
}

function sealedRuntime(): IAgentRuntime {
  const snapshot = captureDevCloudEnvAuthoritySnapshot(process.env);
  if (!snapshot) throw new Error("Expected launcher authority");
  return {
    // Match the agent runtime's sealed overlay, including its absent-value sentinel.
    getSetting: (key: string) =>
      key.startsWith("ELIZAOS_CLOUD_") ? (snapshot.values[key] ?? "") : undefined,
    character: { name: "Small model fixture", bio: ["tests"] },
  } as unknown as IAgentRuntime;
}

async function withLoopbackServer<T>(
  run: (baseUrl: string, requests: Record<string, unknown>[]) => Promise<T>
): Promise<T> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ output_text: "fixture reply" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local HTTP listener");
  try {
    return await run(`http://127.0.0.1:${address.port}/api/v1`, requests);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

async function runSmallText(
  settings: Record<string, string>
): Promise<{ model: unknown; text: string }> {
  return withLoopbackServer(async (baseUrl, requests) => {
    const runtime = stubRuntime({
      ELIZAOS_CLOUD_API_KEY: "fixture-key",
      ELIZAOS_CLOUD_BASE_URL: baseUrl,
      ...settings,
    });
    const text = await handleTextSmall(runtime, { prompt: "Say hi" });
    expect(requests).toHaveLength(1);
    return { model: requests[0]?.model, text: text as string };
  });
}

test("blank SMALL_MODEL falls through to the default on the wire", async () => {
  const { model, text } = await runSmallText({
    ELIZAOS_CLOUD_SMALL_MODEL: "",
    SMALL_MODEL: "   ",
  });
  expect(model).toBe(DEFAULT_SMALL_MODEL);
  expect(text).toBe("fixture reply");
});

test("blank cloud small-model setting falls through to the default on the wire", async () => {
  const { model } = await runSmallText({ ELIZAOS_CLOUD_SMALL_MODEL: "   " });
  expect(model).toBe(DEFAULT_SMALL_MODEL);
});

test("no small-model setting sends the default on the wire", async () => {
  const { model } = await runSmallText({});
  expect(model).toBe(DEFAULT_SMALL_MODEL);
});

test("explicit nonblank SMALL_MODEL is sent unchanged", async () => {
  const { model } = await runSmallText({ SMALL_MODEL: "fixture-small-model" });
  expect(model).toBe("fixture-small-model");
});

test("explicit cloud small-model setting wins over SMALL_MODEL", async () => {
  const { model } = await runSmallText({
    ELIZAOS_CLOUD_SMALL_MODEL: "fixture-cloud-small",
    SMALL_MODEL: "fixture-small-model",
  });
  expect(model).toBe("fixture-cloud-small");
});

test("padded explicit setting is trimmed on the wire", async () => {
  const { model } = await runSmallText({ ELIZAOS_CLOUD_SMALL_MODEL: "  fixture-cloud-small  " });
  expect(model).toBe("fixture-cloud-small");
});

test("explicitly blank sealed model fails loudly with no request on the wire", async () => {
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
  process.env.ELIZAOS_CLOUD_SMALL_MODEL = "";
  await withLoopbackServer(async (_baseUrl, requests) => {
    const runtime = sealedRuntime();
    await expect(handleTextSmall(runtime, { prompt: "Say hi" })).rejects.toThrow(
      "Prepared model request needs provider and model ids"
    );
    expect(requests).toHaveLength(0);
  });
});
