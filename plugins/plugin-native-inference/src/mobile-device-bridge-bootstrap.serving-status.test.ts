/**
 * Serving-status coverage for the mobile bionic host path.
 *
 * `getMobileDeviceBridgeServingStatus` reports the host as serving only after
 * handler registration and a live abstract-UDS probe, which is the readiness
 * signal consumed by smoke tests and local-inference provider status. Abstract
 * AF_UNIX sockets are a Linux kernel feature, so live-socket cases run there;
 * every host still proves registration and unavailable-host decisions.
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
const linuxAbstractSocketIt = process.platform === "linux" ? it : it.skip;

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

/** Fresh module instance so registeredModelTrigger starts null per test. */
async function freshBootstrap() {
  vi.resetModules();
  process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
  return import("./mobile-device-bridge-bootstrap");
}

/** Listen on the Linux abstract-namespace UDS the bionic host would own. */
function listenOnAbstractSocket(name: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.on("error", reject);
    server.listen({ path: `\0${name}` }, () => resolve(server));
  });
}

/** A host that answers each request frame with `reply(request)`. */
function listenAsHost(
  name: string,
  reply: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
        const request = JSON.parse(
          buf.subarray(4, 4 + buf.readUInt32BE(0)).toString("utf8"),
        ) as Record<string, unknown>;
        const payload = Buffer.from(JSON.stringify(reply(request)), "utf8");
        const out = Buffer.allocUnsafe(4 + payload.length);
        out.writeUInt32BE(payload.length, 0);
        payload.copy(out, 4);
        socket.end(out);
      });
    });
    server.on("error", reject);
    server.listen({ path: `\0${name}` }, () => resolve(server));
  });
}

function registeredSlots(runtime: ReturnType<typeof fakeRuntime>): string[] {
  return runtime.registerModel.mock.calls.map((call) => String(call[0]));
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("getMobileDeviceBridgeServingStatus — true bionic serving signal (#11498)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Registration pre-warms model downloads; keep the unit test offline.
    process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD = "1";
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("reports nothing serving before any handler registration", async () => {
    const mod = await freshBootstrap();
    const status = await mod.getMobileDeviceBridgeServingStatus();
    expect(status).toEqual({
      registeredTrigger: null,
      bionicHostServing: false,
    });
  });

  linuxAbstractSocketIt(
    "bionic env set + live socket but handlers NOT registered is NOT serving",
    async () => {
      process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
      process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-unreg";
      const server = await listenOnAbstractSocket("eliza-test-serving-unreg");
      try {
        const mod = await freshBootstrap();
        const status = await mod.getMobileDeviceBridgeServingStatus();
        expect(status.registeredTrigger).toBeNull();
        expect(status.bionicHostServing).toBe(false);
      } finally {
        await closeServer(server);
      }
    },
  );

  linuxAbstractSocketIt(
    "handlers bound via bionic-host AND a live host socket IS serving",
    async () => {
      process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
      process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-live";
      const server = await listenOnAbstractSocket("eliza-test-serving-live");
      try {
        const mod = await freshBootstrap();
        const runtime = fakeRuntime();
        await expect(
          mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never),
        ).resolves.toBe(true);
        const status = await mod.getMobileDeviceBridgeServingStatus();
        expect(status).toEqual({
          registeredTrigger: "bionic-host",
          bionicHostServing: true,
        });
      } finally {
        await closeServer(server);
      }
    },
  );

  it("handlers bound via bionic-host but the host socket is DOWN is NOT serving", async () => {
    process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
    process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-dead";
    // Nothing listens on the socket: the probe must fail, not larp readiness.
    const mod = await freshBootstrap();
    const runtime = fakeRuntime();
    await expect(
      mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never),
    ).resolves.toBe(true);
    const status = await mod.getMobileDeviceBridgeServingStatus();
    expect(status.registeredTrigger).toBe("bionic-host");
    expect(status.bionicHostServing).toBe(false);
  });

  linuxAbstractSocketIt(
    "a host with no text model registers no TEXT handlers and is NOT serving",
    async () => {
      process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
      process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-notext";
      const server = await listenAsHost("eliza-test-serving-notext", (req) =>
        req.op === "capabilities"
          ? {
              ok: true,
              capabilities: {
                text: false,
                embedding: true,
                vision: false,
                asr: true,
                tts: true,
              },
            }
          : { ok: false, error: "unexpected" },
      );
      try {
        const mod = await freshBootstrap();
        const runtime = fakeRuntime();
        await expect(
          mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never),
        ).resolves.toBe(true);
        // Chat then finds no TEXT handler at all, which the runtime reports
        // as NoModelProviderConfiguredError (failureKind no_provider).
        expect(registeredSlots(runtime)).toEqual(["TEXT_EMBEDDING"]);
        const status = await mod.getMobileDeviceBridgeServingStatus();
        expect(status).toEqual({
          registeredTrigger: "bionic-host",
          bionicHostServing: false,
        });
      } finally {
        await closeServer(server);
      }
    },
  );

  linuxAbstractSocketIt(
    "a host with text but no vision registers no IMAGE_DESCRIPTION",
    async () => {
      process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
      process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-novision";
      const server = await listenAsHost("eliza-test-serving-novision", () => ({
        ok: true,
        capabilities: {
          text: true,
          embedding: true,
          vision: false,
          asr: false,
          tts: false,
        },
      }));
      try {
        const mod = await freshBootstrap();
        const runtime = fakeRuntime();
        await mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never);
        expect(registeredSlots(runtime)).toEqual([
          "TEXT_SMALL",
          "TEXT_LARGE",
          "TEXT_EMBEDDING",
        ]);
        const status = await mod.getMobileDeviceBridgeServingStatus();
        expect(status.bionicHostServing).toBe(true);
      } finally {
        await closeServer(server);
      }
    },
  );

  linuxAbstractSocketIt(
    "an older host that does not know op=capabilities keeps every handler",
    async () => {
      process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
      process.env.ELIZA_BIONIC_INFERENCE_SOCK = "eliza-test-serving-oldhost";
      const server = await listenAsHost(
        "eliza-test-serving-oldhost",
        (req) => ({
          ok: false,
          error: `unsupported op: ${String(req.op)}`,
        }),
      );
      try {
        const mod = await freshBootstrap();
        const runtime = fakeRuntime();
        await mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never);
        expect(registeredSlots(runtime)).toEqual([
          "TEXT_SMALL",
          "TEXT_LARGE",
          "TEXT_EMBEDDING",
          "IMAGE_DESCRIPTION",
        ]);
      } finally {
        await closeServer(server);
      }
    },
  );
});
