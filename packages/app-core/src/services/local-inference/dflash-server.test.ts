import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendKvOffloadFlags,
  appendOptimizationFlags,
  dflashDevDisabled,
  dflashEnabled,
  dflashLlamaServer,
  extractStreamingChatDelta,
  extractVerifierRejectRange,
  findBundleOmnivoiceAssets,
  getDflashRuntimeStatus,
  logDflashDevDisabledWarning,
  parseDflashMetrics,
  resolveDflashBinary,
  resolveDflashKvOffload,
  resolveFusedDflashBinary,
  shouldRequireActiveDflashForRequest,
} from "./dflash-server";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
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
    const bundle = path.join(root, "eliza-1-1_7b.bundle");
    fs.mkdirSync(path.join(bundle, "text"), { recursive: true });
    fs.mkdirSync(path.join(bundle, "tts"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "text", "eliza-1-1_7b-32k.gguf"), "x");
    fs.writeFileSync(path.join(bundle, "tts", "omnivoice-0.6b.gguf"), "x");
    fs.writeFileSync(
      path.join(bundle, "tts", "omnivoice-tokenizer-0.6b.gguf"),
      "x",
    );
    const assets = findBundleOmnivoiceAssets(
      path.join(bundle, "text", "eliza-1-1_7b-32k.gguf"),
    );
    expect(assets).not.toBeNull();
    expect(assets?.modelPath).toBe(
      path.join(bundle, "tts", "omnivoice-0.6b.gguf"),
    );
    expect(assets?.codecPath).toBe(
      path.join(bundle, "tts", "omnivoice-tokenizer-0.6b.gguf"),
    );
    // A non-bundle layout (no text/ parent) returns null.
    expect(findBundleOmnivoiceAssets(path.join(root, "model.gguf"))).toBeNull();
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
