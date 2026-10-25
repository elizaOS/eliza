/**
 * #32412: the bionic-host TEXT path must not inject a bridge-only 256-token
 * decode cap when the caller set no limit; the host's `incomplete` receipt is
 * the truncation signal. Uses a real abstract-namespace AF_UNIX host speaking
 * ElizaBionicInferenceServer's length-prefixed JSON frames.
 */

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SERVICE_ENABLED is read at module load, so enable the bridge before importing.
process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";

const ENV_KEYS = [
  "ELIZA_LOCAL_LLAMA",
  "ELIZA_BIONIC_HOST_DELEGATED",
  "ELIZA_BIONIC_INFERENCE_SOCK",
  "ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD",
];
const saved: Record<string, string | undefined> = {};
const SOCK = `eliza-test-output-cap-${process.pid}`;
const linuxAbstractSocketIt = process.platform === "linux" ? it : it.skip;

const seen: { request: Record<string, unknown> | null } = { request: null };
let host: net.Server | null = null;

function frame(json: string): Buffer {
  const payload = Buffer.from(json, "utf8");
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

/** Abstract-UDS host that answers each buffered request with one done frame. */
function startHost(
  reply: (req: Record<string, unknown>) => string,
): net.Server {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let expected = -1;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (expected < 0 && buf.length >= 4) expected = buf.readUInt32BE(0);
      if (expected >= 0 && buf.length >= 4 + expected) {
        const req = JSON.parse(
          buf.subarray(4, 4 + expected).toString("utf8"),
        ) as Record<string, unknown>;
        seen.request = req;
        sock.write(frame(reply(req)));
      }
    });
  });
  server.listen({ path: `\0${SOCK}` });
  return server;
}

function fakeRuntime() {
  const runtime = {
    hasService: vi.fn(() => false),
    registerModel: vi.fn(),
    registerService: vi.fn(async () => undefined),
    registerPlugin: vi.fn(async (plugin: { services?: unknown[] }) => {
      for (const service of plugin.services ?? []) {
        await runtime.registerService(service);
      }
    }),
    getModel: vi.fn(() => undefined),
  };
  return runtime;
}

type GenerateFn = (
  runtime: unknown,
  params: Record<string, unknown>,
) => Promise<string>;

/**
 * Register the bridge handlers against the live host socket and hand back the
 * TEXT_LARGE generate function the runtime would route chat turns to.
 * Registration order is fixed: TEXT_SMALL, TEXT_LARGE, then embedding/vision.
 */
async function textLargeHandler(): Promise<GenerateFn> {
  vi.resetModules();
  const mod = await import("./mobile-device-bridge-bootstrap");
  const runtime = fakeRuntime();
  await expect(
    mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never),
  ).resolves.toBe(true);
  const calls = runtime.registerModel.mock.calls;
  if (calls.length < 2) {
    throw new Error("TEXT_SMALL/TEXT_LARGE handlers were not registered");
  }
  return calls[1][1] as GenerateFn;
}

async function closeHost(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  host = null;
}

describe("bionic-host TEXT handler — no bridge-only decode cap (#32412)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
    process.env.ELIZA_BIONIC_INFERENCE_SOCK = SOCK;
    process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD = "1";
    seen.request = null;
  });

  afterEach(async () => {
    if (host) await closeHost(host);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  linuxAbstractSocketIt(
    "omits maxTokens from the wire request when the caller sets no limit",
    async () => {
      host = startHost(() =>
        JSON.stringify({ ok: true, text: "hi", tokens: 3 }),
      );
      const generate = await textLargeHandler();

      await expect(generate({}, { prompt: "hello" })).resolves.toBe("hi");

      expect(seen.request).not.toBeNull();
      expect(seen.request).not.toHaveProperty("maxTokens");
    },
  );

  linuxAbstractSocketIt(
    "does not reject a host-completed long reply when no caller limit was set",
    async () => {
      // 4096 tokens decoded with no caller limit: past the old injected 256 cap
      // this used to throw MODEL_OUTPUT_INCOMPLETE for a finished reply.
      host = startHost(() =>
        JSON.stringify({ ok: true, text: "long reply", tokens: 4096 }),
      );
      const generate = await textLargeHandler();

      await expect(generate({}, { prompt: "hello" })).resolves.toBe(
        "long reply",
      );
    },
  );

  linuxAbstractSocketIt(
    "still rejects a native incomplete receipt with no caller limit",
    async () => {
      host = startHost(() =>
        JSON.stringify({
          ok: true,
          text: "partial",
          tokens: 4096,
          incomplete: true,
          finishReason: "generation_boundary",
        }),
      );
      const generate = await textLargeHandler();

      await expect(generate({}, { prompt: "hello" })).rejects.toMatchObject({
        code: "MODEL_OUTPUT_INCOMPLETE",
      });
    },
  );
});
