// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { elizaCloudRoutePlugin } from "../../../../plugins/plugin-elizacloud/src/plugin.ts";
import { tryHandleRuntimePluginRoute } from "../../../agent/src/api/runtime-plugin-routes.ts";
import { registerHttpPluginRoutes } from "../../../host/src/api/http-plugin-runtime.ts";
import { setBootConfig } from "../../../ui/src/config/boot-config-store.ts";
import { ANDROID_LOCAL_AGENT_IPC_BASE } from "../../../ui/src/first-run/mobile-runtime-mode.ts";
import { transcribeCloudWav } from "../../../ui/src/voice/local-asr-transcribe.ts";
import type {
  NativeAgentRequestOptions,
  NativeAgentRequestResult,
} from "../../src/renderer/transports/android-native-agent-transport";

const native = vi.hoisted(() => ({
  request: async (
    _options: NativeAgentRequestOptions,
  ): Promise<NativeAgentRequestResult> => {
    throw new Error("native agent not started");
  },
}));

vi.mock("@capacitor/core", async (original) => {
  const actual = await original<typeof import("@capacitor/core")>();
  const agent = {
    request: (options: NativeAgentRequestOptions) => native.request(options),
    addListener: async () => ({ remove: async () => {} }),
  };
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => true,
      getPlatform: () => "android",
      isPluginAvailable: () => true,
      Plugins: { Agent: agent },
      registerPlugin: () => agent,
    },
    registerPlugin: () => agent,
  };
});

import "../../src/renderer/transports/configure.ts";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function wavBytes(): Uint8Array {
  const samples = 16000 * 30;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(i % 2 === 0 ? 0x7f80 : -0x7f81, 44 + i * 2);
  }
  return new Uint8Array(buffer);
}

describe("Android local agent Cloud voice input", () => {
  const agentToken = randomUUID();
  const cloudKey = `placeholder-${randomUUID()}`;
  const uploads: Buffer[] = [];
  let cloud: { server: Server; origin: string };
  let agent: { server: Server; origin: string };

  beforeAll(async () => {
    cloud = await listen(async (req, res) => {
      try {
        const form = await new Request("http://cloud.local/voice/stt", {
          method: "POST",
          headers: { "content-type": String(req.headers["content-type"]) },
          body: await readBody(req),
        }).formData();
        const audio = form.get("audio");
        uploads.push(
          audio instanceof Blob
            ? Buffer.from(await audio.arrayBuffer())
            : Buffer.alloc(0),
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ text: "turn on the kitchen lights" }));
      } catch (error) {
        res.statusCode = 400;
        res.end(String(error));
      }
    });
    vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", `${cloud.origin}/api/v1`);
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", cloudKey);

    const runtime = {} as AgentRuntime;
    registerHttpPluginRoutes(runtime, elizaCloudRoutePlugin);
    agent = await listen(async (req, res) => {
      const url = new URL(req.url ?? "/", agent.origin);
      const handled = await tryHandleRuntimePluginRoute({
        req,
        res,
        method: req.method ?? "GET",
        pathname: url.pathname,
        url,
        runtime,
        isAuthorized: () =>
          req.headers.authorization === `Bearer ${agentToken}`,
      });
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
    native.request = async (options) => {
      const response = await fetch(`${agent.origin}${options.path}`, {
        method: options.method,
        headers: options.headers,
        body: options.body ?? undefined,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    };
    setBootConfig({
      apiBase: ANDROID_LOCAL_AGENT_IPC_BASE,
      apiToken: agentToken,
    } as Parameters<typeof setBootConfig>[0]);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => agent?.server.close(resolve));
    await new Promise((resolve) => cloud?.server.close(resolve));
  });

  it("transcribes a 30-second WAV through the native agent bridge", async () => {
    const audio = wavBytes();

    await expect(transcribeCloudWav(audio, { timeoutMs: 5000 })).resolves.toBe(
      "turn on the kitchen lights",
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.equals(Buffer.from(audio))).toBe(true);
  });
});
