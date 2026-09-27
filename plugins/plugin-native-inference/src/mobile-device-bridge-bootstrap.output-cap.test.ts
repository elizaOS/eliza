/**
 * Regression coverage for #32412 — the bionic-host TEXT path must not inject a
 * bridge-only decode cap.
 *
 * The stock Android bridge built `maxTokens: lane.maxTokens ?? 256`, so a caller
 * that requested no output limit was silently capped at 256 decoded tokens and
 * the response was then rejected with MODEL_OUTPUT_INCOMPLETE even when the
 * native host had finished the reply (tokens >= 256 >= injected cap). The
 * canonical sibling contract in
 * plugins/plugin-local-inference/src/services/bionic-host-loader.ts already
 * handles this: it omits an absent limit from the wire request, treats an
 * explicit limit only when the caller supplied one, and otherwise trusts the
 * host's own `incomplete` receipt.
 *
 * Real transport: a live abstract-namespace AF_UNIX host that speaks the same
 * 4-byte length-prefixed JSON frames as ElizaBionicInferenceServer.java.
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

/** Abstract-UDS host that streams several frames for op=generateStream. */
function startStreamingHost(
  reply: (req: Record<string, unknown>) => string[],
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
        let delay = 0;
        for (const json of reply(req)) {
          delay += 5;
          const full = frame(json);
          setTimeout(() => sock.write(full), delay);
        }
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
      // 4096 tokens decoded with no caller limit: below the injected 256 cap
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

  linuxAbstractSocketIt(
    "forwards an explicit caller limit and rejects output that fills it",
    async () => {
      host = startHost(() =>
        JSON.stringify({ ok: true, text: "capped", tokens: 512 }),
      );
      const generate = await textLargeHandler();

      await expect(
        generate({}, { prompt: "hello", maxTokens: 512 }),
      ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
      expect(seen.request?.maxTokens).toBe(512);
    },
  );

  linuxAbstractSocketIt(
    "serves a completion below an explicit caller limit",
    async () => {
      host = startHost(() =>
        JSON.stringify({ ok: true, text: "short", tokens: 7 }),
      );
      const generate = await textLargeHandler();

      await expect(
        generate({}, { prompt: "hello", maxTokens: 512 }),
      ).resolves.toBe("short");
      expect(seen.request?.maxTokens).toBe(512);
    },
  );

  linuxAbstractSocketIt(
    "keeps the uncapped contract on the streaming transport too",
    async () => {
      host = startStreamingHost(() => [
        JSON.stringify({ type: "token", text: "stre" }),
        JSON.stringify({ type: "token", text: "amed" }),
        JSON.stringify({
          type: "done",
          ok: true,
          text: "streamed",
          tokens: 4096,
        }),
      ]);
      const generate = await textLargeHandler();
      const chunks: string[] = [];

      await expect(
        generate(
          {},
          { prompt: "hello", onStreamChunk: (t: string) => chunks.push(t) },
        ),
      ).resolves.toBe("streamed");
      expect(seen.request?.op).toBe("generateStream");
      expect(seen.request).not.toHaveProperty("maxTokens");
      expect(chunks.join("")).toBe("streamed");
    },
  );
});
