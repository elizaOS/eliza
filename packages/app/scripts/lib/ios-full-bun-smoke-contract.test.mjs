/**
 * Deterministic host-side coverage for every proof carried by the real iOS full-Bun result.
 */
import { describe, expect, it } from "bun:test";
import {
  assertIosFullBunSmokeSuccess,
  iosFullBunSmokeResultTimeMs,
  parseIosFullBunSmokeResult,
} from "./ios-full-bun-smoke-contract.mjs";

function validResult() {
  return {
    runtimeStatus: { ready: true, engine: "bun" },
    bridgeStatus: {
      ready: true,
      engine: "bun",
      transport: "bun-host-ipc",
    },
    fetchHealth: { ready: true, runtime: "ok" },
    localInference: {
      hub: { installed: [{ id: "eliza-1-2b" }] },
      device: {
        enabled: true,
        connected: true,
        transport: "bun-host-ipc",
        devices: [],
      },
      providers: {
        providers: [
          {
            id: "capacitor-llama",
            registeredSlots: ["TEXT_SMALL", "TEXT_LARGE"],
          },
        ],
      },
      installed: { models: [{ id: "eliza-1-2b" }] },
      activatedModel: {
        status: "ready",
        modelPath: "/models/eliza-1-2b.gguf",
      },
      active: { status: "ready" },
    },
    conversationId: "conversation-1",
    sendMessage: { text: "The iOS full Bun local backend is running." },
    streamMessage:
      'data: {"type":"done","text":"The iOS full Bun local backend is running."}\n\n',
  };
}

function changed(mutator) {
  const result = structuredClone(validResult());
  mutator(result);
  return result;
}

describe("iOS full-Bun smoke result parsing", () => {
  it("returns an explicit invalid signal for missing, scalar, array, and malformed payloads", () => {
    for (const raw of [null, "", " ", "null", "1", "[]", "{broken"]) {
      expect(parseIosFullBunSmokeResult(raw)).toBeNull();
    }
    expect(parseIosFullBunSmokeResult('{"ok":true}')).toEqual({ ok: true });
  });

  it("selects the first valid lifecycle timestamp", () => {
    expect(iosFullBunSmokeResultTimeMs(null)).toBeNull();
    expect(iosFullBunSmokeResultTimeMs({ updatedAt: "invalid" })).toBeNull();
    expect(
      iosFullBunSmokeResultTimeMs({
        updatedAt: "invalid",
        finishedAt: "2026-07-13T12:00:00.000Z",
        startedAt: "2026-07-13T11:00:00.000Z",
      }),
    ).toBe(Date.parse("2026-07-13T12:00:00.000Z"));
  });
});

describe("iOS full-Bun smoke success contract", () => {
  it("accepts complete Bun/IPC/model proof, including an empty scanner result", () => {
    expect(() => assertIosFullBunSmokeSuccess(validResult())).not.toThrow();
    const noScannerModels = changed((result) => {
      result.localInference.hub.installed = [];
      delete result.localInference.activatedModel;
      delete result.localInference.active;
    });
    expect(() => assertIosFullBunSmokeSuccess(noScannerModels)).not.toThrow();
  });

  it.each([
    [
      "runtime shape",
      (result) => {
        result.runtimeStatus = null;
      },
      /runtimeStatus was not an object/,
    ],
    [
      "runtime engine",
      (result) => {
        result.runtimeStatus.engine = "proxy";
      },
      /not ready on bun/,
    ],
    [
      "bridge transport",
      (result) => {
        result.bridgeStatus.transport = "http";
      },
      /did not report bun-host-ipc/,
    ],
    [
      "bridge port fallback",
      (result) => {
        result.bridgeStatus.apiPort = 31337;
      },
      /exposed port metadata/,
    ],
    [
      "fetch health",
      (result) => {
        result.fetchHealth.ready = false;
      },
      /fetchHealth was not ready/,
    ],
    [
      "local inference shape",
      (result) => {
        result.localInference = [];
      },
      /localInference was not an object/,
    ],
    [
      "hub installed shape",
      (result) => {
        result.localInference.hub.installed = null;
      },
      /hub.installed was not an array/,
    ],
    [
      "device transport",
      (result) => {
        result.localInference.device.connected = false;
      },
      /device bridge was not connected/,
    ],
    [
      "device list",
      (result) => {
        result.localInference.device.devices = null;
      },
      /device.devices was not an array/,
    ],
    [
      "provider list",
      (result) => {
        result.localInference.providers.providers = null;
      },
      /provider list was not an array/,
    ],
    [
      "capacitor provider",
      (result) => {
        result.localInference.providers.providers = [];
      },
      /did not include capacitor-llama/,
    ],
    [
      "registered slots",
      (result) => {
        result.localInference.providers.providers[0].registeredSlots = [
          "TEXT_SMALL",
        ];
      },
      /did not register TEXT_SMALL\/TEXT_LARGE/,
    ],
    [
      "conversation id",
      (result) => {
        result.conversationId = "";
      },
      /did not return a conversationId/,
    ],
    [
      "installed models shape",
      (result) => {
        result.localInference.installed.models = null;
      },
      /installed.models was not an array/,
    ],
    [
      "scanner mismatch",
      (result) => {
        result.localInference.installed.models = [];
      },
      /scanner saw an installed model/,
    ],
    [
      "activation state",
      (result) => {
        result.localInference.activatedModel.status = "loading";
      },
      /model activation was not ready/,
    ],
    [
      "active state",
      (result) => {
        result.localInference.active.status = "idle";
      },
      /active model was not ready/,
    ],
    [
      "non-streaming reply",
      (result) => {
        result.sendMessage.text = "not the model reply";
      },
      /sendMessage did not return the expected/,
    ],
    [
      "fabricated failure reply",
      (result) => {
        result.sendMessage.text = "Failed to generate response";
      },
      /sendMessage did not return the expected/,
    ],
    [
      "stream completion",
      (result) => {
        result.streamMessage =
          'data: {"type":"content","text":"The iOS full Bun local backend is running."}\n\n';
      },
      /stream did not return the expected/,
    ],
  ])("rejects missing %s proof", (_name, mutator, expected) => {
    expect(() => assertIosFullBunSmokeSuccess(changed(mutator))).toThrow(
      expected,
    );
  });
});
