/**
 * Proves a valid, non-default ELIZA_DEVICE_GENERATE_TIMEOUT_MS actually
 * reaches the real setTimeout call inside sendToPrimary() - not just that
 * the standalone parser resolves it correctly in isolation. Boots the
 * canonical device bridge through a real HTTP server and a real WebSocket
 * device connection (same harness as mobile-device-bridge-headless-boot.test.ts),
 * spies on the global setTimeout, and asserts the delay used for a live
 * generate() call equals the configured value, not the 600s default.
 */
import http from "node:http";
import net from "node:net";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WebSocket } from "ws";

const savedEnv = {
  ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
  ELIZA_DEVICE_PAIRING_TOKEN: process.env.ELIZA_DEVICE_PAIRING_TOKEN,
  ELIZA_DEVICE_GENERATE_TIMEOUT_MS:
    process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS,
};

const pairingToken = "timeout-wiring-pairing-token";
// Deliberately not the 600_000 default and not a round number, so this test
// cannot pass by coincidentally matching the fallback.
const CONFIGURED_GENERATE_TIMEOUT_MS = 475;

process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
process.env.ELIZA_DEVICE_PAIRING_TOKEN = pairingToken;
process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS = String(
  CONFIGURED_GENERATE_TIMEOUT_MS,
);

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Timeout-wiring server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("mobile device bridge activation-time timeout wiring", () => {
  it("uses the exact configured ELIZA_DEVICE_GENERATE_TIMEOUT_MS for a live generate() call", async () => {
    const bridge = await import("./mobile-device-bridge-bootstrap");
    const server = http.createServer((_req, res) => res.end("ok"));
    let socket: WebSocket | null = null;
    let pendingRejection: Promise<void> | undefined;
    let restoreTimeoutSpy: (() => void) | undefined;

    try {
      await bridge.attachMobileDeviceBridgeToServer(server);
      const port = await listen(server);
      socket = new WebSocket(
        `ws://127.0.0.1:${port}/api/local-inference/device-bridge?token=${pairingToken}`,
      );
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", resolve);
        socket?.once("error", reject);
      });
      socket.send(
        JSON.stringify({
          type: "register",
          payload: {
            deviceId: "timeout-wiring-device",
            pairingToken,
            capabilities: {
              platform: "android",
              deviceModel: "timeout-wiring-test",
              totalRamGb: 8,
              cpuCores: 8,
              gpu: { backend: "vulkan", available: true },
            },
            loadedPath: null,
          },
        }),
      );
      await waitFor(
        () => bridge.mobileDeviceBridge.status().connected,
        "device registration",
      );

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      restoreTimeoutSpy = () => setTimeoutSpy.mockRestore();
      // Never resolved by the fake device - this call exists only to reach
      // the setTimeout(..., timeoutMs) call inside sendToPrimary().
      const pendingGenerate = bridge.mobileDeviceBridge.generate({
        prompt: "wiring probe",
      });
      pendingRejection = expect(pendingGenerate).rejects.toThrow();

      await waitFor(
        () => bridge.mobileDeviceBridge.status().pendingRequests === 1,
        "pending generate RPC",
      );

      const generateTimeoutCall = setTimeoutSpy.mock.calls.find(
        (call) => call[1] === CONFIGURED_GENERATE_TIMEOUT_MS,
      );
      expect(generateTimeoutCall).toBeDefined();
      // Mutation-resistant: also confirm the default was NOT what fired -
      // catches a mutation that ignores the configured value entirely.
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 600_000)).toBe(
        false,
      );
    } finally {
      restoreTimeoutSpy?.();
      // The timer assertion is complete; teardown must not wait for its deadline.
      await bridge.mobileDeviceBridge.close();
      await pendingRejection;
      socket?.terminate();
      if (server.listening) await new Promise((r) => server.close(r));
    }
  });
});

const linuxAbstractSocketIt = process.platform === "linux" ? it : it.skip;
const BIONIC_ENV_KEYS = [
  "ELIZA_BIONIC_HOST_DELEGATED",
  "ELIZA_BIONIC_INFERENCE_SOCK",
  "ELIZA_BIONIC_REQUEST_TIMEOUT_MS",
  "ELIZA_BIONIC_STREAM_IDLE_TIMEOUT_MS",
  "ELIZA_DEVICE_GENERATE_TIMEOUT_MS",
  "ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD",
  "ELIZA_LOCAL_LLAMA",
] as const;

function hostFrame(value: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

/**
 * Abstract-UDS bionic host. Buffered requests are answered at once; a
 * generateStream connection is handed to the test to drive frame by frame.
 */
async function startBionicHost(name: string) {
  const state: {
    stream: net.Socket | null;
    streamClosed: boolean;
    buffered: Record<string, unknown>[];
  } = { stream: null, streamClosed: false, buffered: [] };
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      const req = JSON.parse(
        buf.subarray(4, 4 + buf.readUInt32BE(0)).toString("utf8"),
      ) as Record<string, unknown>;
      if (req.op === "generateStream") {
        state.stream = socket;
        socket.on("close", () => {
          state.streamClosed = true;
        });
        return;
      }
      state.buffered.push(req);
      socket.end(
        req.op === "capabilities"
          ? hostFrame({ ok: false, error: "unsupported op: capabilities" })
          : hostFrame({ ok: true, text: "buffered", tokens: 2 }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: `\0${name}` }, () => resolve());
  });
  return { server, state };
}

type StreamParams = {
  prompt: string;
  onStreamChunk?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
};

async function bionicTextLarge(): Promise<
  (runtime: unknown, params: StreamParams) => Promise<string>
> {
  vi.resetModules();
  const mod = await import("./mobile-device-bridge-bootstrap");
  const runtime = {
    hasService: vi.fn(() => false),
    registerModel: vi.fn(),
    registerService: vi.fn(async () => undefined),
    registerPlugin: vi.fn(async () => undefined),
    getModel: vi.fn(() => undefined),
  };
  await mod.ensureMobileDeviceBridgeInferenceHandlers(runtime as never);
  return runtime.registerModel.mock.calls[1][1] as never;
}

/** Let real socket I/O run while timers are fake. */
async function settle(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000 && !predicate(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
}

describe("bionic host request deadlines", () => {
  const savedBionicEnv: Record<string, string | undefined> = {};
  let host: Awaited<ReturnType<typeof startBionicHost>> | null = null;

  async function useHost(name: string) {
    process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
    process.env.ELIZA_BIONIC_INFERENCE_SOCK = name;
    host = await startBionicHost(name);
    return host;
  }

  beforeEach(() => {
    for (const key of BIONIC_ENV_KEYS) {
      savedBionicEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD = "1";
  });

  afterEach(async () => {
    vi.useRealTimers();
    host?.state.stream?.destroy();
    if (host) await new Promise((r) => host?.server.close(r));
    host = null;
    for (const key of BIONIC_ENV_KEYS) {
      if (savedBionicEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedBionicEnv[key];
    }
  });

  linuxAbstractSocketIt(
    "completes a stream that sends a token every 200s for 15 minutes",
    async () => {
      process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS = "3600000";
      const { state } = await useHost(`eliza-test-stream-slow-${process.pid}`);
      const generate = await bionicTextLarge();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const chunks: string[] = [];
      const reply = generate(
        {},
        { prompt: "hello", onStreamChunk: (text) => void chunks.push(text) },
      );
      await settle(() => state.stream !== null, "stream request");
      for (let i = 0; i < 5; i += 1) {
        vi.advanceTimersByTime(200_000);
        state.stream?.write(hostFrame({ type: "token", text: `t${i}` }));
        await settle(() => chunks.length === i + 1, `token ${i}`);
      }
      state.stream?.end(
        hostFrame({
          type: "done",
          ok: true,
          text: "t0t1t2t3t4",
          tokens: 5,
          incomplete: false,
        }),
      );
      await expect(reply).resolves.toBe("t0t1t2t3t4");
      expect(chunks).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    },
  );

  linuxAbstractSocketIt(
    "fails a silent stream after the idle bound",
    async () => {
      process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS = "3600000";
      const { state } = await useHost(`eliza-test-stream-idle-${process.pid}`);
      const generate = await bionicTextLarge();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const reply = generate({}, { prompt: "hello", onStreamChunk: () => {} });
      const failed = expect(reply).rejects.toThrow(/sent nothing for 300000ms/);
      await settle(() => state.stream !== null, "stream request");
      vi.advanceTimersByTime(300_000);
      await failed;
      await settle(() => state.streamClosed, "host sees the hang-up");
    },
  );

  linuxAbstractSocketIt(
    "gives a buffered generate the device-generate deadline",
    async () => {
      process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS = "987654";
      await useHost(`eliza-test-buffered-deadline-${process.pid}`);
      const generate = await bionicTextLarge();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        await expect(generate({}, { prompt: "hello" })).resolves.toBe(
          "buffered",
        );
        expect(
          setTimeoutSpy.mock.calls.some((call) => call[1] === 987654),
        ).toBe(true);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    },
  );

  linuxAbstractSocketIt(
    "closes the host connection when the caller aborts",
    async () => {
      const { state } = await useHost(`eliza-test-stream-abort-${process.pid}`);
      const generate = await bionicTextLarge();
      const controller = new AbortController();
      const reply = generate(
        {},
        { prompt: "hello", onStreamChunk: () => {}, signal: controller.signal },
      );
      await settle(() => state.stream !== null, "stream request");
      controller.abort();
      await expect(reply).rejects.toMatchObject({ name: "AbortError" });
      await settle(() => state.streamClosed, "host sees the hang-up");
    },
  );

  linuxAbstractSocketIt(
    "fails the stream when the chunk callback rejects",
    async () => {
      const { state } = await useHost(`eliza-test-stream-cb-${process.pid}`);
      const generate = await bionicTextLarge();
      const reply = generate(
        {},
        {
          prompt: "hello",
          onStreamChunk: async () => {
            throw new Error("sink closed");
          },
        },
      );
      await settle(() => state.stream !== null, "stream request");
      state.stream?.write(hostFrame({ type: "token", text: "a" }));
      await expect(reply).rejects.toThrow("sink closed");
    },
  );
});
