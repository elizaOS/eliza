import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetCtxCheckpointsProbeCacheForTests,
  __resetLlamaServerHelpTextForTests,
  __setCtxCheckpointsProbeCacheForTests,
  __setLlamaServerHelpTextForTests,
  appendCtxCheckpointFlags,
  appendDflashDraftTuningFlags,
  appendKvOffloadFlags,
  appendMetalSafeStartupFlags,
  appendOptimizationFlags,
  attachDflashSpeculativeRequestFields,
  DEFAULT_CTX_CHECKPOINT_INTERVAL,
  DEFAULT_CTX_CHECKPOINTS,
  DflashLlamaServer,
  dflashDevDisabled,
  dflashEnabled,
  dflashLlamaServer,
  estimateOutputTokensForDflashEvidence,
  extractStreamingChatDelta,
  extractVerifierRejectRange,
  findBundleOmnivoiceAssets,
  getDflashRuntimeStatus,
  logDflashDevDisabledWarning,
  parseDflashMetrics,
  resolveDflashBinary,
  resolveDflashKvOffload,
  resolveDisableThinkingFlags,
  resolveFusedDflashBinary,
  resolveMetalRuntimeCacheTypes,
  shouldRequireActiveDflashForRequest,
  validateDflashDrafterCompatibility,
} from "./dflash-server";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  __resetLlamaServerHelpTextForTests();
});

function makeManagedBinary(root: string): string {
  const backend = process.platform === "darwin" ? "metal" : "cpu";
  const managed = path.join(
    root,
    "local-inference",
    "bin",
    "dflash",
    `${process.platform}-${process.arch}-${backend}`,
    "llama-server",
  );
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, "#!/bin/sh\n", "utf8");
  fs.chmodSync(managed, 0o755);
  return managed;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value), 0);
  return out;
}

function ggufString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([u64(body.length), body]);
}

function ggufScalar(type: number, value: string | number | boolean): Buffer {
  if (type === 8) return ggufString(String(value));
  if (type === 4) return u32(Number(value));
  if (type === 5) {
    const out = Buffer.alloc(4);
    out.writeInt32LE(Number(value), 0);
    return out;
  }
  if (type === 7) return Buffer.from([value ? 1 : 0]);
  throw new Error(`unsupported test scalar type ${type}`);
}

function ggufArray(
  innerType: number,
  values: Array<string | number | boolean>,
): Buffer {
  return Buffer.concat([
    u32(9),
    u32(innerType),
    u64(values.length),
    ...values.map((value) => ggufScalar(innerType, value)),
  ]);
}

function writeTinyGguf(
  file: string,
  opts: { architecture: string; tokens?: string[]; merges?: string[] },
): void {
  const metadata: Array<[string, Buffer]> = [
    [
      "general.architecture",
      Buffer.concat([u32(8), ggufString(opts.architecture)]),
    ],
    ["tokenizer.ggml.model", Buffer.concat([u32(8), ggufString("gpt2")])],
    ["tokenizer.ggml.pre", Buffer.concat([u32(8), ggufString("qwen2")])],
    ["tokenizer.ggml.tokens", ggufArray(8, opts.tokens ?? ["a", "b", "c"])],
    ["tokenizer.ggml.token_type", ggufArray(5, [1, 1, 1])],
    ["tokenizer.ggml.merges", ggufArray(8, opts.merges ?? ["a b"])],
    ["tokenizer.ggml.eos_token_id", Buffer.concat([u32(4), u32(2)])],
    ["tokenizer.ggml.bos_token_id", Buffer.concat([u32(4), u32(1)])],
    ["tokenizer.ggml.padding_token_id", Buffer.concat([u32(4), u32(0)])],
    ["tokenizer.ggml.add_bos_token", Buffer.concat([u32(7), Buffer.from([1])])],
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from("GGUF", "utf8"),
      u32(3),
      u64(0),
      u64(metadata.length),
      ...metadata.flatMap(([key, encoded]) => [ggufString(key), encoded]),
    ]),
  );
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function startStreamingMockServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      res.statusCode = 200;
      res.end(
        [
          "llamacpp:prompt_tokens_total 0",
          "llamacpp:n_tokens_predicted_total 0",
          "llamacpp:n_drafted_total 2",
          "llamacpp:n_accepted_total 2",
        ].join("\n"),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(req)) as { stream?: boolean };
      expect(body.stream).toBe(true);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("DFlash runtime discovery", () => {
  it("auto-enables when the managed binary exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dflash-test-"));
    process.env.ELIZA_STATE_DIR = root;
    delete process.env.ELIZA_DFLASH_ENABLED;
    delete process.env.ELIZA_DFLASH_DISABLED;
    delete process.env.ELIZA_DFLASH_METAL_AUTO;
    delete process.env.ELIZA_DFLASH_METAL_ENABLED;
    delete process.env.HIP_VISIBLE_DEVICES;
    delete process.env.ROCR_VISIBLE_DEVICES;
    delete process.env.CUDA_VISIBLE_DEVICES;
    const binary = makeManagedBinary(root);

    expect(resolveDflashBinary()).toBe(binary);
    expect(dflashEnabled()).toBe(true);
    expect(getDflashRuntimeStatus().enabled).toBe(true);
  });

  it("does not use PATH llama-server unless explicitly enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dflash-test-"));
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "llama-server"), "#!/bin/sh\n", "utf8");
    fs.chmodSync(path.join(binDir, "llama-server"), 0o755);
    process.env.ELIZA_STATE_DIR = root;
    process.env.PATH = `${binDir}${path.delimiter}${originalEnv.PATH ?? ""}`;
    delete process.env.ELIZA_DFLASH_ENABLED;
    delete process.env.HIP_VISIBLE_DEVICES;
    delete process.env.ROCR_VISIBLE_DEVICES;
    delete process.env.CUDA_VISIBLE_DEVICES;

    expect(dflashEnabled()).toBe(false);
    expect(resolveDflashBinary()).toBe(null);

    process.env.ELIZA_DFLASH_ENABLED = "1";
    expect(resolveDflashBinary()).toBe(path.join(binDir, "llama-server"));
  });
});

describe("fused-vs-two-process spawn selection", () => {
  function fusedBackendKey(): string {
    const backend = process.platform === "darwin" ? "metal" : "cpu";
    return `${process.platform}-${process.arch}-${backend}-fused`;
  }
  function makeFusedBinary(
    root: string,
    caps: Record<string, unknown> = {},
  ): { dir: string; bin: string } {
    const dir = path.join(
      root,
      "local-inference",
      "bin",
      "dflash",
      fusedBackendKey(),
    );
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "llama-server");
    fs.writeFileSync(bin, "#!/bin/sh\n", "utf8");
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(
      path.join(dir, "CAPABILITIES.json"),
      JSON.stringify({
        target: fusedBackendKey(),
        platform: process.platform,
        arch: process.arch,
        backend: process.platform === "darwin" ? "metal" : "cpu",
        builtAt: new Date().toISOString(),
        fork: "elizaOS/llama.cpp",
        forkCommit: "test",
        kernels: {
          dflash: true,
          turbo3: true,
          turbo4: true,
          turbo3_tcq: false,
          qjl_full: false,
          polarquant: false,
          lookahead: true,
          ngramDraft: true,
        },
        binaries: ["llama-cli", "llama-omnivoice-server", "llama-server"],
        fused: true,
        omnivoice: { commit: "test" },
        ...caps,
      }),
      "utf8",
    );
    return { dir, bin };
  }
  function clearEnv() {
    delete process.env.ELIZA_DFLASH_ENABLED;
    delete process.env.ELIZA_DFLASH_DISABLED;
    delete process.env.ELIZA_DFLASH_METAL_AUTO;
    delete process.env.ELIZA_DFLASH_METAL_ENABLED;
    delete process.env.ELIZA_DFLASH_DISABLE_FUSED_SERVER;
    delete process.env.ELIZA_DFLASH_LLAMA_SERVER;
    delete process.env.HIP_VISIBLE_DEVICES;
    delete process.env.ROCR_VISIBLE_DEVICES;
    delete process.env.CUDA_VISIBLE_DEVICES;
  }

  it("prefers the fused llama-server when a fused build is installed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-fused-test-"));
    process.env.ELIZA_STATE_DIR = root;
    clearEnv();
    const { bin } = makeFusedBinary(root);
    expect(resolveFusedDflashBinary()).toBe(bin);
    // resolveDflashBinary() should pick the fused binary over the (absent)
    // stock binary, so the spawn layer launches the single fused server.
    expect(resolveDflashBinary()).toBe(bin);
  });

  it("falls back to the stock two-process path when no fused build exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-fused-test-"));
    process.env.ELIZA_STATE_DIR = root;
    clearEnv();
    const stock = makeManagedBinary(root);
    expect(resolveFusedDflashBinary()).toBe(null);
    expect(resolveDflashBinary()).toBe(stock);
  });

  it("ignores a fused dir whose CAPABILITIES.json does not advertise fusion", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-fused-test-"));
    process.env.ELIZA_STATE_DIR = root;
    clearEnv();
    makeFusedBinary(root, {
      fused: false,
      omnivoice: null,
      binaries: ["llama-server"],
    });
    expect(resolveFusedDflashBinary()).toBe(null);
  });

  it("ELIZA_DFLASH_DISABLE_FUSED_SERVER forces the stock path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-fused-test-"));
    process.env.ELIZA_STATE_DIR = root;
    clearEnv();
    makeFusedBinary(root);
    makeManagedBinary(root);
    process.env.ELIZA_DFLASH_DISABLE_FUSED_SERVER = "1";
    expect(resolveFusedDflashBinary()).toBe(null);
  });

  it("ELIZA_DFLASH_LLAMA_SERVER override wins over the fused binary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-fused-test-"));
    process.env.ELIZA_STATE_DIR = root;
    clearEnv();
    makeFusedBinary(root);
    const explicitDir = path.join(root, "explicit");
    fs.mkdirSync(explicitDir, { recursive: true });
    const explicit = path.join(explicitDir, "llama-server");
    fs.writeFileSync(explicit, "#!/bin/sh\n", "utf8");
    fs.chmodSync(explicit, 0o755);
    process.env.ELIZA_DFLASH_LLAMA_SERVER = explicit;
    expect(resolveDflashBinary()).toBe(explicit);
  });

  it("findBundleOmnivoiceAssets resolves tts/ GGUFs from the text model path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-bundle-test-"));
    const bundle = path.join(root, "eliza-1-2b.bundle");
    fs.mkdirSync(path.join(bundle, "text"), { recursive: true });
    fs.mkdirSync(path.join(bundle, "tts"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "text", "eliza-1-2b-32k.gguf"), "x");
    fs.writeFileSync(path.join(bundle, "tts", "omnivoice-0.8b.gguf"), "x");
    fs.writeFileSync(
      path.join(bundle, "tts", "omnivoice-tokenizer-0.8b.gguf"),
      "x",
    );
    const assets = findBundleOmnivoiceAssets(
      path.join(bundle, "text", "eliza-1-2b-32k.gguf"),
    );
    expect(assets).not.toBeNull();
    expect(assets?.modelPath).toBe(
      path.join(bundle, "tts", "omnivoice-0.8b.gguf"),
    );
    expect(assets?.codecPath).toBe(
      path.join(bundle, "tts", "omnivoice-tokenizer-0.8b.gguf"),
    );
    // A non-bundle layout (no text/ parent) returns null.
    expect(findBundleOmnivoiceAssets(path.join(root, "model.gguf"))).toBeNull();
  });
});

describe("DFlash draft CLI flag drift", () => {
  it("prefers --reasoning off over deprecated chat-template kwargs when both are advertised", () => {
    const bin = "/tmp/reasoning-llama-server";
    __setLlamaServerHelpTextForTests(
      bin,
      "--reasoning [on|off|auto]\n--chat-template-kwargs JSON\n",
    );

    expect(resolveDisableThinkingFlags(bin)).toEqual(["--reasoning", "off"]);
  });

  it("detects aliased llama-server reasoning flags and disables the thinking budget", () => {
    const bin = "/tmp/reasoning-aliased-llama-server";
    __setLlamaServerHelpTextForTests(
      bin,
      [
        "-rea,  --reasoning [on|off|auto]",
        "--reasoning-budget N",
        "--reasoning-format FORMAT",
      ].join("\n"),
    );

    expect(resolveDisableThinkingFlags(bin)).toEqual([
      "--reasoning",
      "off",
      "--reasoning-budget",
      "0",
    ]);
  });

  it("adds -fit off for Metal fused binaries to avoid unsafe fit-time compressed-KV graphs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "metal-fit-"));
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(binary, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binary, 0o755);
    fs.writeFileSync(
      path.join(root, "CAPABILITIES.json"),
      JSON.stringify({
        target: "darwin-arm64-metal-fused",
        backend: "metal",
        kernels: { dflash: true },
      }),
      "utf8",
    );
    __setLlamaServerHelpTextForTests(binary, "-fit,  --fit [on|off]\n");
    const args: string[] = [];

    appendMetalSafeStartupFlags(args, binary);

    expect(args).toEqual(["-fit", "off"]);
  });

  it("downgrades compressed QJL/Polar KV to q8_0 on Metal runtime graph dispatch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "metal-kv-"));
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(binary, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binary, 0o755);
    fs.writeFileSync(
      path.join(root, "CAPABILITIES.json"),
      JSON.stringify({
        target: "darwin-arm64-metal-fused",
        backend: "metal",
        kernels: { dflash: true, qjl_full: true, polarquant: true },
      }),
      "utf8",
    );

    const resolved = resolveMetalRuntimeCacheTypes({
      binaryPath: binary,
      targetModelPath: "/models/eliza-1-2b.gguf",
      cacheTypeK: "qjl1_256",
      cacheTypeV: "q4_polar",
      emitWarning: false,
    });

    expect(resolved).toMatchObject({
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      downgraded: true,
    });
    expect(resolved.reason).toContain("generic attention/MUL_MAT");
  });

  it("keeps compressed KV on Metal only when the unsafe experiment flag is explicit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "metal-kv-exp-"));
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(binary, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binary, 0o755);
    fs.writeFileSync(
      path.join(root, "CAPABILITIES.json"),
      JSON.stringify({
        target: "darwin-arm64-metal-fused",
        backend: "metal",
        kernels: { dflash: true, qjl_full: true, polarquant: true },
      }),
      "utf8",
    );
    process.env.ELIZA_DFLASH_METAL_COMPRESSED_KV = "1";

    const resolved = resolveMetalRuntimeCacheTypes({
      binaryPath: binary,
      targetModelPath: "/models/eliza-1-2b.gguf",
      cacheTypeK: "qjl1_256",
      cacheTypeV: "q4_polar",
      emitWarning: false,
    });

    expect(resolved).toMatchObject({
      cacheTypeK: "qjl1_256",
      cacheTypeV: "q4_polar",
      downgraded: false,
    });
  });

  it("uses current speculative draft count flags and omits removed draft ctx flag", () => {
    const bin = "/tmp/current-llama-server";
    __setLlamaServerHelpTextForTests(
      bin,
      [
        "--spec-draft-n-min N",
        "--spec-draft-n-max N",
        "--spec-draft-ngl, --n-gpu-layers-draft N",
      ].join("\n"),
    );
    const args: string[] = [];

    appendDflashDraftTuningFlags(args, {
      binaryPath: bin,
      draftContextSize: 2048,
      draftMin: 1,
      draftMax: 4,
    });

    expect(args).toEqual([
      "--spec-draft-n-min",
      "1",
      "--spec-draft-n-max",
      "4",
    ]);
    expect(args).not.toContain("--ctx-size-draft");
  });

  it("keeps legacy aliases for older fork binaries that still advertise them", () => {
    const bin = "/tmp/legacy-llama-server";
    __setLlamaServerHelpTextForTests(
      bin,
      ["--ctx-size-draft N", "--draft-min N", "--draft-max N"].join("\n"),
    );
    const args: string[] = [];

    appendDflashDraftTuningFlags(args, {
      binaryPath: bin,
      draftContextSize: 2048,
      draftMin: 1,
      draftMax: 4,
    });

    expect(args).toEqual([
      "--ctx-size-draft",
      "2048",
      "--draft-min",
      "1",
      "--draft-max",
      "4",
    ]);
  });
});

describe("ELIZA_DFLASH_DISABLE developer kill-switch", () => {
  it("disables DFlash even when ELIZA_DFLASH_ENABLED forces it on", () => {
    delete process.env.ELIZA_DFLASH_DISABLE;
    process.env.ELIZA_DFLASH_ENABLED = "1";
    expect(dflashDevDisabled()).toBe(false);
    expect(dflashEnabled()).toBe(true);

    process.env.ELIZA_DFLASH_DISABLE = "1";
    expect(dflashDevDisabled()).toBe(true);
    expect(dflashEnabled()).toBe(false);
    expect(getDflashRuntimeStatus().reason).toContain("ELIZA_DFLASH_DISABLE");
  });

  it("logs a loud warning when active and is silent otherwise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env.ELIZA_DFLASH_DISABLE;
      logDflashDevDisabledWarning();
      expect(warn).not.toHaveBeenCalled();

      process.env.ELIZA_DFLASH_DISABLE = "1";
      logDflashDevDisabledWarning();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("ELIZA_DFLASH_DISABLE=1");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("parseDflashMetrics", () => {
  it("parses Prometheus counters with label sets and _total suffix", () => {
    const text = `# HELP llamacpp:n_decode_total Number of tokens decoded by the model.
# TYPE llamacpp:n_decode_total counter
llamacpp:n_decode_total 128
# HELP llamacpp:n_drafted_total Number of tokens drafted.
# TYPE llamacpp:n_drafted_total counter
llamacpp:n_drafted_total 200
# HELP llamacpp:n_drafted_accepted_total Number of drafted tokens accepted.
# TYPE llamacpp:n_drafted_accepted_total counter
llamacpp:n_drafted_accepted_total{slot_id="0"} 130
`;
    const snapshot = parseDflashMetrics(text);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.decoded).toBe(128);
    expect(snapshot?.drafted).toBe(200);
    expect(snapshot?.accepted).toBe(130);
    expect(snapshot?.acceptanceRate).toBeCloseTo(0.65, 5);
  });

  it("falls back to non-_total counter names emitted by older fork builds", () => {
    const text = `llamacpp:n_decode 64
llamacpp:n_drafted 100
llamacpp:n_drafted_accepted 75
`;
    const snapshot = parseDflashMetrics(text);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.decoded).toBe(64);
    expect(snapshot?.drafted).toBe(100);
    expect(snapshot?.accepted).toBe(75);
    expect(snapshot?.acceptanceRate).toBeCloseTo(0.75, 5);
  });

  it("prefers unlabelled totals over labelled shard samples", () => {
    const text = `llamacpp:n_decode_total 64
llamacpp:n_drafted_total{slot_id="0"} 10
llamacpp:n_drafted_total{slot_id="1"} 20
llamacpp:n_drafted_total 40
llamacpp:n_drafted_accepted_total{slot_id="0"} 4
llamacpp:n_drafted_accepted_total{slot_id="1"} 5
llamacpp:n_drafted_accepted_total 12
`;
    const snapshot = parseDflashMetrics(text);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.drafted).toBe(40);
    expect(snapshot?.accepted).toBe(12);
  });

  it("returns null when the response has no speculative counters", () => {
    const text = `# HELP some_other_metric Random gauge.
# TYPE some_other_metric gauge
some_other_metric 1.0
`;
    expect(parseDflashMetrics(text)).toBeNull();
  });

  it("reports NaN acceptance when drafter has not produced any tokens", () => {
    const text = `llamacpp:n_decode_total 16
llamacpp:n_drafted_total 0
llamacpp:n_drafted_accepted_total 0
`;
    const snapshot = parseDflashMetrics(text);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.drafted).toBe(0);
    expect(Number.isNaN(snapshot?.acceptanceRate)).toBe(true);
  });
});

describe("shouldRequireActiveDflashForRequest", () => {
  it("does not require draft evidence for tiny prewarm-style requests", () => {
    expect(
      shouldRequireActiveDflashForRequest(
        { draftMin: 2, disableDrafter: false },
        1,
      ),
    ).toBe(false);
    expect(
      shouldRequireActiveDflashForRequest(
        { draftMin: 2, disableDrafter: false },
        3,
      ),
    ).toBe(false);
  });

  it("requires draft evidence once the request is long enough to verify a draft", () => {
    expect(
      shouldRequireActiveDflashForRequest(
        { draftMin: 2, disableDrafter: false },
        4,
      ),
    ).toBe(true);
  });

  it("does not require draft evidence when a requested long turn finishes before a draft window exists", () => {
    expect(
      shouldRequireActiveDflashForRequest(
        { draftMin: 8, disableDrafter: false },
        96,
        9,
      ),
    ).toBe(false);
  });

  it("requires draft evidence when both the request and observed turn are long enough", () => {
    expect(
      shouldRequireActiveDflashForRequest(
        { draftMin: 8, disableDrafter: false },
        96,
        12,
      ),
    ).toBe(true);
  });

  it("does not require draft evidence when the drafter is deliberately disabled", () => {
    expect(
      shouldRequireActiveDflashForRequest(
        { draftMin: 2, disableDrafter: true },
        128,
      ),
    ).toBe(false);
  });

  it("allows zero draft only behind the local diagnostics escape hatch", () => {
    process.env.ELIZA_DFLASH_ALLOW_ZERO_DRAFT = "1";
    expect(
      shouldRequireActiveDflashForRequest(
        { draftMin: 2, disableDrafter: false },
        128,
      ),
    ).toBe(false);
  });
});

describe("DFlash speculative request fields", () => {
  it("stamps every active DFlash request with explicit per-task speculative settings", () => {
    const payload: Record<string, unknown> = {};

    attachDflashSpeculativeRequestFields(payload, {
      draftMin: 2,
      draftMax: 6,
      disableDrafter: false,
    });

    expect(payload).toMatchObject({
      "speculative.n_min": 2,
      "speculative.n_max": 6,
      "speculative.type": "dflash",
    });
  });

  it("does not stamp target-only diagnostic launches", () => {
    const payload: Record<string, unknown> = {};

    attachDflashSpeculativeRequestFields(payload, {
      draftMin: 2,
      draftMax: 6,
      disableDrafter: true,
    });

    expect(payload).toEqual({});
  });

  it("estimates streamed output length when llama-server omits predicted-token metrics", () => {
    expect(
      estimateOutputTokensForDflashEvidence(
        {
          output_tokens: 0,
        },
        "A visible streamed answer with enough text to require a draft.",
      ),
    ).toBeGreaterThan(4);
  });

  it("prefers exact response usage when available", () => {
    expect(
      estimateOutputTokensForDflashEvidence(
        {
          output_tokens: 17,
        },
        "tiny",
      ),
    ).toBe(17);
  });
});

describe("validateDflashDrafterCompatibility", () => {
  it("passes a plain autoregressive drafter with matching tokenizer metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-gguf-test-"));
    const target = path.join(root, "target.gguf");
    const drafter = path.join(root, "drafter.gguf");
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(
      binary,
      "#!/bin/sh\necho '--spec-type none,draft,dflash'\n",
      "utf8",
    );
    writeTinyGguf(target, { architecture: "qwen3" });
    writeTinyGguf(drafter, { architecture: "qwen3" });

    const report = validateDflashDrafterCompatibility({
      targetModelPath: target,
      drafterModelPath: drafter,
      binaryPath: binary,
    });

    expect(report.compatible).toBe(true);
    expect(report.tokenizerMismatches).toEqual([]);
  });

  it("rejects tokenizer metadata mismatches before runtime startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-gguf-test-"));
    const target = path.join(root, "target.gguf");
    const drafter = path.join(root, "drafter.gguf");
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(
      binary,
      "#!/bin/sh\necho '--spec-type none,draft,dflash'\n",
      "utf8",
    );
    writeTinyGguf(target, { architecture: "qwen3", tokens: ["a", "b", "c"] });
    writeTinyGguf(drafter, { architecture: "qwen3", tokens: ["x", "y", "z"] });

    const report = validateDflashDrafterCompatibility({
      targetModelPath: target,
      drafterModelPath: drafter,
      binaryPath: binary,
    });

    expect(report.compatible).toBe(false);
    expect(report.reason).toContain("tokenizer metadata mismatch");
    expect(report.tokenizerMismatches.map((m) => m.key)).toContain(
      "tokenizer.ggml.tokens",
    );
  });

  it("rejects dflash-draft architecture unless the binary advertises loader support", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-gguf-test-"));
    const target = path.join(root, "target.gguf");
    const drafter = path.join(root, "drafter.gguf");
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(
      binary,
      "#!/bin/sh\necho '--spec-type none,draft,dflash'\n",
      "utf8",
    );
    writeTinyGguf(target, { architecture: "qwen3" });
    writeTinyGguf(drafter, { architecture: "dflash-draft" });

    const report = validateDflashDrafterCompatibility({
      targetModelPath: target,
      drafterModelPath: drafter,
      binaryPath: binary,
    });

    expect(report.compatible).toBe(false);
    expect(report.reason).toContain("dflash-draft");
    expect(report.reason).toContain("does not advertise");
  });

  it("accepts dflash-draft architecture when CAPABILITIES advertises loader support", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-gguf-test-"));
    const target = path.join(root, "target.gguf");
    const drafter = path.join(root, "drafter.gguf");
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(binary, "#!/bin/sh\n", "utf8");
    fs.writeFileSync(
      path.join(root, "CAPABILITIES.json"),
      JSON.stringify({
        target: "test",
        platform: process.platform,
        arch: process.arch,
        backend: "cpu",
        builtAt: new Date().toISOString(),
        fork: "elizaOS/llama.cpp",
        forkCommit: "test",
        kernels: {
          dflash: true,
          turbo3: true,
          turbo4: true,
          turbo3_tcq: true,
          qjl_full: true,
          polarquant: true,
          lookahead: true,
          ngramDraft: true,
        },
        binaries: ["llama-server"],
        supportedArchitectures: ["dflash-draft"],
        draftArchitectures: ["dflash-draft"],
        dflashDraftArchitecture: true,
      }),
      "utf8",
    );
    writeTinyGguf(target, { architecture: "qwen3" });
    writeTinyGguf(drafter, { architecture: "dflash-draft" });

    const report = validateDflashDrafterCompatibility({
      targetModelPath: target,
      drafterModelPath: drafter,
      binaryPath: binary,
    });

    expect(report.compatible).toBe(true);
    expect(report.reason).toContain("compatible");
  });

  it("hard-fails startup instead of launching target-only when drafter preflight fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-gguf-test-"));
    const target = path.join(root, "target.gguf");
    const drafter = path.join(root, "drafter.gguf");
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(
      binary,
      "#!/bin/sh\necho '--spec-type none,draft,dflash'\n",
      "utf8",
    );
    fs.chmodSync(binary, 0o755);
    __setLlamaServerHelpTextForTests(binary, "--spec-type none,draft,dflash\n");
    writeTinyGguf(target, { architecture: "qwen3", tokens: ["a", "b", "c"] });
    writeTinyGguf(drafter, {
      architecture: "dflash-draft",
      tokens: ["x", "y", "z"],
    });
    process.env.ELIZA_DFLASH_ENABLED = "1";
    process.env.ELIZA_DFLASH_LLAMA_SERVER = binary;

    const server = new DflashLlamaServer();
    await expect(
      server.start({
        targetModelPath: target,
        drafterModelPath: drafter,
        contextSize: 128,
        draftContextSize: 64,
        draftMin: 1,
        draftMax: 4,
        gpuLayers: 0,
        draftGpuLayers: 0,
        disableThinking: false,
      }),
    ).rejects.toThrow(/refusing to launch/);
    expect(server.hasLoadedModel()).toBe(false);
  });
});

describe("extractStreamingChatDelta", () => {
  it("extracts OpenAI chat streaming delta content", () => {
    expect(
      extractStreamingChatDelta({
        choices: [{ delta: { content: "Hello" } }],
      }),
    ).toBe("Hello");
  });

  it("extracts legacy text streaming chunks", () => {
    expect(
      extractStreamingChatDelta({
        choices: [{ text: "Hi" }, { text: " there" }],
      }),
    ).toBe("Hi there");
  });

  it("ignores role-only or malformed chunks", () => {
    expect(
      extractStreamingChatDelta({
        choices: [{ delta: { role: "assistant" } }],
      }),
    ).toBe("");
    expect(extractStreamingChatDelta(null)).toBe("");
  });
});

describe("extractVerifierRejectRange", () => {
  it("returns null when the chunk has no verifier extension", () => {
    expect(
      extractVerifierRejectRange({ choices: [{ delta: { content: "hi" } }] }),
    ).toBeNull();
    expect(extractVerifierRejectRange(null)).toBeNull();
    expect(extractVerifierRejectRange({ verifier: {} })).toBeNull();
  });

  it("parses a well-formed inclusive reject range", () => {
    expect(
      extractVerifierRejectRange({ verifier: { rejected: [3, 5] } }),
    ).toEqual([3, 5]);
    expect(
      extractVerifierRejectRange({ verifier: { rejected: [0, 0] } }),
    ).toEqual([0, 0]);
  });

  it("rejects malformed ranges", () => {
    expect(
      extractVerifierRejectRange({ verifier: { rejected: [5, 3] } }),
    ).toBeNull();
    expect(
      extractVerifierRejectRange({ verifier: { rejected: [1] } }),
    ).toBeNull();
    expect(
      extractVerifierRejectRange({ verifier: { rejected: [-1, 2] } }),
    ).toBeNull();
    expect(
      extractVerifierRejectRange({ verifier: { rejected: [1.5, 2] } }),
    ).toBeNull();
  });
});

describe("DFlash streaming callbacks", () => {
  it("synthesizes verifier accept events from streamed OpenAI deltas", async () => {
    const mock = await startStreamingMockServer();
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
    };
    const previous = {
      baseUrl: target.baseUrl,
      cacheParallel: target.cacheParallel,
    };
    target.baseUrl = mock.baseUrl;
    target.cacheParallel = 4;
    const textChunks: string[] = [];
    const verifierChunks: Array<{ index: number; text: string }> = [];
    try {
      const result = await dflashLlamaServer.generateWithUsage({
        prompt: "say hello",
        onTextChunk: (chunk) => {
          textChunks.push(chunk);
        },
        onVerifierEvent: (event) => {
          expect(event.kind).toBe("accept");
          verifierChunks.push(...event.tokens);
        },
      });

      expect(result.text).toBe("Hello");
      expect(textChunks).toEqual(["Hel", "lo"]);
      expect(verifierChunks).toEqual([
        { index: 0, text: "Hel" },
        { index: 1, text: "lo" },
      ]);
    } finally {
      target.baseUrl = previous.baseUrl;
      target.cacheParallel = previous.cacheParallel;
      await mock.close();
    }
  });

  it("uses final streaming timings as DFlash evidence when metrics counters lag", async () => {
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/metrics") {
        res.statusCode = 200;
        res.end(
          [
            "llamacpp:prompt_tokens_total 0",
            "llamacpp:n_tokens_predicted_total 0",
            "llamacpp:n_drafted_total 0",
            "llamacpp:n_accepted_total 0",
          ].join("\n"),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "Hello" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ finish_reason: "stop", index: 0, delta: {} }],
            timings: {
              prompt_n: 12,
              predicted_n: 5,
              draft_n: 4,
              draft_n_accepted: 3,
            },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
    };
    const previous = {
      baseUrl: target.baseUrl,
      cacheParallel: target.cacheParallel,
    };
    target.baseUrl = baseUrl;
    target.cacheParallel = 4;
    try {
      const result = await dflashLlamaServer.generateWithUsage({
        prompt: "say hello",
        onTextChunk: () => {},
      });

      expect(result.text).toBe("Hello");
      expect(result.usage).toMatchObject({
        input_tokens: 12,
        output_tokens: 5,
        dflash_drafted_tokens: 4,
        dflash_accepted_tokens: 3,
        dflash_acceptance_rate: 0.75,
      });
    } finally {
      target.baseUrl = previous.baseUrl;
      target.cacheParallel = previous.cacheParallel;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("repairs deterministic structured-output spans while suppressing duplicate server bytes", async () => {
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/metrics") {
        res.statusCode = 200;
        res.end(
          [
            "llamacpp:prompt_tokens_total 0",
            "llamacpp:n_tokens_predicted_total 0",
            "llamacpp:n_drafted_total 2",
            "llamacpp:n_accepted_total 2",
          ].join("\n"),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '{"action":"BLO' } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: 'CK","parameters":{}' } }],
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
    };
    const previous = {
      baseUrl: target.baseUrl,
      cacheParallel: target.cacheParallel,
    };
    target.baseUrl = baseUrl;
    target.cacheParallel = 4;
    const textChunks: string[] = [];
    try {
      const result = await dflashLlamaServer.generateWithUsage({
        prompt: "choose action",
        responseSkeleton: {
          spans: [
            { kind: "literal", value: '{"action":' },
            { kind: "enum", key: "action", enumValues: ["BLOCK", "BRIEF"] },
            { kind: "literal", value: ',"parameters":' },
            { kind: "free-json", key: "parameters" },
            { kind: "literal", value: "}" },
          ],
        },
        onTextChunk: (chunk) => {
          textChunks.push(chunk);
        },
      });

      expect(result.text).toBe('{"action":"BLOCK","parameters":{}}');
      expect(textChunks).toEqual(['{"action":"BLOCK","parameters":', "{}}"]);
    } finally {
      target.baseUrl = previous.baseUrl;
      target.cacheParallel = previous.cacheParallel;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("consumes native DFlash events when the bundle opts in and /health advertises the capability", async () => {
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            status: "ok",
            capabilities: { dflashNativeEvents: true },
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/metrics") {
        res.statusCode = 200;
        res.end(
          [
            "llamacpp:prompt_tokens_total 0",
            "llamacpp:n_tokens_predicted_total 0",
            "llamacpp:n_drafted_total 4",
            "llamacpp:n_accepted_total 3",
          ].join("\n"),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "Hel" } }],
            dflash: [
              { kind: "speculate-start", round: 0, ts: 0 },
              {
                kind: "accept",
                drafted: [10, 11],
                accepted: [10, 11],
                ts: 1,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "lo" } }],
            dflash: {
              kind: "accept",
              drafted: [12, 13],
              accepted: [12],
              ts: 2,
            },
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "" } }],
            dflash: {
              kind: "speculate-end",
              round: 0,
              totalDrafted: 4,
              totalAccepted: 3,
              ts: 3,
            },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
      lastOptimizations: { nativeDflashEvents?: boolean } | null;
      nativeDflashEventsCapability: boolean | null;
    };
    const previous = {
      baseUrl: target.baseUrl,
      cacheParallel: target.cacheParallel,
      lastOptimizations: target.lastOptimizations,
      nativeDflashEventsCapability: target.nativeDflashEventsCapability,
    };
    target.baseUrl = baseUrl;
    target.cacheParallel = 4;
    target.lastOptimizations = { nativeDflashEvents: true };
    target.nativeDflashEventsCapability = null;
    const verifierEvents: string[] = [];
    const nativeKinds: string[] = [];
    try {
      const result = await dflashLlamaServer.generateWithUsage({
        prompt: "hi",
        onTextChunk: () => {},
        onVerifierEvent: (event) => {
          verifierEvents.push(event.kind);
        },
        onDflashEvent: (event) => {
          nativeKinds.push(event.kind);
        },
      });

      // Legacy synthesized accept events MUST be suppressed when native
      // events are flowing — only the optional `reject` callbacks pass through.
      expect(verifierEvents).toEqual([]);
      expect(nativeKinds).toEqual([
        "speculate-start",
        "accept",
        "accept",
        "speculate-end",
      ]);
      expect(result.text).toBe("Hello");
      expect(result.dflashStats).toEqual({
        drafted: 4,
        accepted: 3,
        rounds: 1,
        acceptanceRate: 3 / 4,
      });
    } finally {
      target.baseUrl = previous.baseUrl;
      target.cacheParallel = previous.cacheParallel;
      target.lastOptimizations = previous.lastOptimizations;
      target.nativeDflashEventsCapability =
        previous.nativeDflashEventsCapability;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("falls back to JS synthesis when /health does not advertise dflashNativeEvents", async () => {
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok", capabilities: {} }));
        return;
      }
      if (req.method === "GET" && req.url === "/metrics") {
        res.statusCode = 200;
        res.end(
          [
            "llamacpp:prompt_tokens_total 0",
            "llamacpp:n_tokens_predicted_total 0",
            "llamacpp:n_drafted_total 0",
            "llamacpp:n_accepted_total 0",
          ].join("\n"),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "Hi" } }],
            dflash: { kind: "accept", drafted: [1], accepted: [1], ts: 0 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
      lastOptimizations: { nativeDflashEvents?: boolean } | null;
      nativeDflashEventsCapability: boolean | null;
    };
    const previous = {
      baseUrl: target.baseUrl,
      cacheParallel: target.cacheParallel,
      lastOptimizations: target.lastOptimizations,
      nativeDflashEventsCapability: target.nativeDflashEventsCapability,
    };
    target.baseUrl = baseUrl;
    target.cacheParallel = 4;
    target.lastOptimizations = { nativeDflashEvents: true };
    target.nativeDflashEventsCapability = null;
    const verifierKinds: string[] = [];
    const nativeKinds: string[] = [];
    try {
      const result = await dflashLlamaServer.generateWithUsage({
        prompt: "hi",
        onTextChunk: () => {},
        onVerifierEvent: (event) => {
          verifierKinds.push(event.kind);
        },
        onDflashEvent: (event) => {
          nativeKinds.push(event.kind);
        },
      });
      // Capability missing → legacy synthesis remains active.
      expect(verifierKinds).toEqual(["accept"]);
      expect(nativeKinds).toEqual([]);
      expect(result.dflashStats).toBeUndefined();
    } finally {
      target.baseUrl = previous.baseUrl;
      target.cacheParallel = previous.cacheParallel;
      target.lastOptimizations = previous.lastOptimizations;
      target.nativeDflashEventsCapability =
        previous.nativeDflashEventsCapability;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("DflashLlamaServer.prewarmConversation", () => {
  it("fires a 1-token cache_prompt request against the given slot", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        seen.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
        res.statusCode = 200;
        res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
      lastPrewarmBySlot: Map<number, { prefix: string; touchedAtMs: number }>;
    };
    const prev = {
      baseUrl: target.baseUrl,
      cacheParallel: target.cacheParallel,
    };
    target.baseUrl = `http://127.0.0.1:${port}`;
    target.cacheParallel = 4;
    target.lastPrewarmBySlot.clear();
    try {
      const warmed = await dflashLlamaServer.prewarmConversation(
        "system you are helpful",
        { slotId: 2 },
      );
      expect(warmed).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        max_tokens: 1,
        temperature: 0,
        cache_prompt: true,
        slot_id: 2,
      });
      // The prefix is tracked for the keep-alive sweep, keyed by slot.
      expect(target.lastPrewarmBySlot.get(2)?.prefix).toBe(
        "system you are helpful",
      );
    } finally {
      target.baseUrl = prev.baseUrl;
      target.cacheParallel = prev.cacheParallel;
      target.lastPrewarmBySlot.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns false (no throw) when the server is not running", async () => {
    const target = dflashLlamaServer as unknown as { baseUrl: string | null };
    const prev = target.baseUrl;
    target.baseUrl = null;
    try {
      await expect(
        dflashLlamaServer.prewarmConversation("anything", { slotId: 0 }),
      ).resolves.toBe(false);
      await expect(
        dflashLlamaServer.prewarmConversation("", { slotId: 0 }),
      ).resolves.toBe(false);
    } finally {
      target.baseUrl = prev;
    }
  });
});

describe("llama-server optimization flags", () => {
  it("keeps KV placement distinct from layer offload", () => {
    const args: string[] = [];
    appendKvOffloadFlags(args, resolveDflashKvOffload({ kvOffload: "cpu" }));
    expect(args).toEqual(["--no-kv-offload"]);

    expect(resolveDflashKvOffload({ kvOffload: { gpuLayers: 10 } })).toBeNull();
  });

  it("uses ELIZA_LOCAL_KV_OFFLOAD when no per-load KV override is present", () => {
    process.env.ELIZA_LOCAL_KV_OFFLOAD = "cpu";
    expect(resolveDflashKvOffload(undefined)).toBe("cpu");
    expect(resolveDflashKvOffload({ kvOffload: "gpu" })).toBe("gpu");
  });

  it("appends cache, batching, and server offload knobs from catalog metadata", () => {
    const args: string[] = [];
    appendOptimizationFlags(args, {
      cacheReuse: 256,
      cacheRamMb: 4096,
      batchSize: 1024,
      ubatchSize: 128,
      contBatching: true,
      kvUnified: true,
      opOffload: false,
    });

    expect(args).toEqual([
      "--cache-reuse",
      "256",
      "--cache-ram",
      "4096",
      "--batch-size",
      "1024",
      "--ubatch-size",
      "128",
      "--cont-batching",
      "--kv-unified",
      "--no-op-offload",
    ]);
  });

  it("lets env override cache and batching optimization metadata", () => {
    process.env.ELIZA_LOCAL_CACHE_REUSE = "64";
    process.env.ELIZA_LOCAL_CONT_BATCHING = "off";
    const args: string[] = [];
    appendOptimizationFlags(args, {
      cacheReuse: 256,
      contBatching: true,
    });

    expect(args).toEqual(["--cache-reuse", "64", "--no-cont-batching"]);
  });
});

describe("appendCtxCheckpointFlags", () => {
  /**
   * Fake binary that advertises --ctx-checkpoints in its --help output so the
   * runtime probe returns `true` without a real llama-server install.
   */
  function fakeBinaryPath(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-llama-server-"));
    const p = path.join(tmp, "llama-server");
    // Write a shell script that echoes a --help blurb containing the flag.
    fs.writeFileSync(
      p,
      "#!/bin/sh\necho '--ctx-checkpoints N'\necho '--ctx-checkpoint-interval M'\nexit 0\n",
      "utf8",
    );
    fs.chmodSync(p, 0o755);
    return p;
  }

  afterEach(() => {
    __resetCtxCheckpointsProbeCacheForTests();
  });

  it("exports DEFAULT_CTX_CHECKPOINTS=4 and DEFAULT_CTX_CHECKPOINT_INTERVAL=256", () => {
    expect(DEFAULT_CTX_CHECKPOINTS).toBe(4);
    expect(DEFAULT_CTX_CHECKPOINT_INTERVAL).toBe(256);
  });

  it("applies module defaults when optimizations provide no checkpoint values", () => {
    const binary = fakeBinaryPath();
    __setCtxCheckpointsProbeCacheForTests(binary, true);
    __setLlamaServerHelpTextForTests(
      binary,
      "--ctx-checkpoints N\n--ctx-checkpoint-interval N\n",
    );
    const args: string[] = [];
    appendCtxCheckpointFlags(args, null, binary);
    expect(args).toEqual([
      "--ctx-checkpoints",
      String(DEFAULT_CTX_CHECKPOINTS),
      "--ctx-checkpoint-interval",
      String(DEFAULT_CTX_CHECKPOINT_INTERVAL),
    ]);
  });

  it("uses catalog values when provided, ignoring defaults", () => {
    const binary = fakeBinaryPath();
    __setCtxCheckpointsProbeCacheForTests(binary, true);
    __setLlamaServerHelpTextForTests(
      binary,
      "--ctx-checkpoints N\n--ctx-checkpoint-interval N\n",
    );
    const args: string[] = [];
    appendCtxCheckpointFlags(
      args,
      { ctxCheckpoints: 8, ctxCheckpointInterval: 4096 },
      binary,
    );
    expect(args).toEqual([
      "--ctx-checkpoints",
      "8",
      "--ctx-checkpoint-interval",
      "4096",
    ]);
  });

  it("is a no-op when enableCheckpoints is explicitly false", () => {
    const binary = fakeBinaryPath();
    const args: string[] = [];
    appendCtxCheckpointFlags(args, null, binary, false);
    expect(args).toHaveLength(0);
  });

  it("is a no-op for Metal fused builds because SET_ROWS checkpoints abort during graph reserve", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "metal-ctx-ckpt-"));
    const binary = path.join(root, "llama-server");
    fs.writeFileSync(binary, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binary, 0o755);
    fs.writeFileSync(
      path.join(root, "CAPABILITIES.json"),
      JSON.stringify({
        target: "darwin-arm64-metal-fused",
        backend: "metal",
        kernels: { dflash: true },
      }),
      "utf8",
    );
    __setCtxCheckpointsProbeCacheForTests(binary, true);
    __setLlamaServerHelpTextForTests(
      binary,
      "--ctx-checkpoints N\n--ctx-checkpoint-interval N\n",
    );

    const args: string[] = [];
    appendCtxCheckpointFlags(args, null, binary);

    expect(args).toHaveLength(0);
  });

  it("is a no-op when the binary does not advertise the flags", () => {
    // Write a binary whose --help does NOT mention --ctx-checkpoints.
    const tmp = os.tmpdir();
    const noFlagBinary = path.join(tmp, `no-ctx-ckpt-${Date.now()}`);
    fs.writeFileSync(noFlagBinary, "#!/bin/sh\necho '--ctx-size N'\n", "utf8");
    fs.chmodSync(noFlagBinary, 0o755);

    const args: string[] = [];
    appendCtxCheckpointFlags(args, null, noFlagBinary);
    expect(args).toHaveLength(0);
  });

  it("does not append a checkpoint interval flag when a partial fork lacks it", () => {
    const bin = "/tmp/partial-ctx-checkpoint-llama-server";
    __setCtxCheckpointsProbeCacheForTests(bin, true);
    __setLlamaServerHelpTextForTests(bin, "--ctx-checkpoints N\n");
    const args: string[] = [];

    appendCtxCheckpointFlags(args, null, bin);

    expect(args).toEqual([
      "--ctx-checkpoints",
      String(DEFAULT_CTX_CHECKPOINTS),
    ]);
  });
});
