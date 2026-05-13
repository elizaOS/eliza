import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAppleSilicon,
  looksLikeMlxModelDir,
  MLX_BACKEND_ID,
  MlxLocalServer,
  mlxBackendEligible,
  mlxOptIn,
  resolveMlxModelDir,
} from "./mlx-server";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function readFetchJson(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== "string") return {};
  return JSON.parse(body) as Record<string, unknown>;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("mlx-server: opt-in + eligibility (convenience path)", () => {
  it("MLX_BACKEND_ID is mlx-server", () => {
    expect(MLX_BACKEND_ID).toBe("mlx-server");
  });

  it("mlxOptIn is false unless ELIZA_LOCAL_MLX or ELIZA_LOCAL_BACKEND=mlx-server", () => {
    withEnv(
      { ELIZA_LOCAL_MLX: undefined, ELIZA_LOCAL_BACKEND: undefined },
      () => {
        expect(mlxOptIn()).toBe(false);
      },
    );
    withEnv({ ELIZA_LOCAL_MLX: "1" }, () => {
      expect(mlxOptIn()).toBe(true);
    });
    withEnv(
      { ELIZA_LOCAL_MLX: undefined, ELIZA_LOCAL_BACKEND: "mlx-server" },
      () => {
        expect(mlxOptIn()).toBe(true);
      },
    );
  });

  it("eligibility is never true without the explicit opt-in", () => {
    withEnv(
      { ELIZA_LOCAL_MLX: undefined, ELIZA_LOCAL_BACKEND: undefined },
      () => {
        const d = mlxBackendEligible();
        expect(d.eligible).toBe(false);
        expect(d.reason).toMatch(/opt-in/i);
      },
    );
  });

  it("eligibility refuses on non-Apple-Silicon hosts even when opted in", () => {
    if (isAppleSilicon()) {
      // On a real Apple-Silicon CI box this branch can't be exercised; the
      // assertion below ('not Apple Silicon') only fires off-arch.
      return;
    }
    withEnv({ ELIZA_LOCAL_MLX: "1" }, () => {
      const d = mlxBackendEligible();
      expect(d.eligible).toBe(false);
      expect(d.reason).toMatch(/Apple Silicon/i);
    });
  });

  it("looksLikeMlxModelDir wants config.json + a .safetensors, rejects gguf-only dirs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mlx-test-"));
    try {
      expect(looksLikeMlxModelDir(tmp)).toBe(false);
      fs.writeFileSync(path.join(tmp, "config.json"), "{}");
      expect(looksLikeMlxModelDir(tmp)).toBe(false);
      fs.writeFileSync(path.join(tmp, "model.gguf"), "x");
      expect(looksLikeMlxModelDir(tmp)).toBe(false); // gguf is the llama.cpp path
      fs.writeFileSync(path.join(tmp, "model.safetensors"), "x");
      expect(looksLikeMlxModelDir(tmp)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolveMlxModelDir honours ELIZA_MLX_MODEL_DIR when it points at a valid dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mlx-model-"));
    try {
      fs.writeFileSync(path.join(tmp, "config.json"), "{}");
      fs.writeFileSync(path.join(tmp, "model.safetensors"), "x");
      withEnv({ ELIZA_MLX_MODEL_DIR: tmp }, () => {
        expect(resolveMlxModelDir()).toBe(tmp);
      });
      withEnv({ ELIZA_MLX_MODEL_DIR: path.join(tmp, "nope") }, () => {
        // invalid -> falls through (and the state-dir lookup won't find one)
        const r = resolveMlxModelDir();
        expect(r === null || r === tmp).toBe(true);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("MlxLocalServer: spawn-and-route (mocked mlx_lm.server)", () => {
  let svc: MlxLocalServer | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.unload();
      svc = null;
    }
    vi.unstubAllGlobals();
  });

  it("health-checks /v1/models and routes /v1/chat/completions (non-streaming)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const rawUrl =
          typeof input === "string" || input instanceof URL ? input : input.url;
        const url = new URL(rawUrl);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.pathname === "/v1/models") {
          return Response.json({ data: [{ id: "eliza-1-0_8b-mlx" }] });
        }
        if (url.pathname === "/v1/chat/completions" && method === "POST") {
          const parsed = readFetchJson(init);
          expect(parsed.model).toBe("eliza-1-0_8b-mlx");
          const messages = parsed.messages as
            | Array<{ content?: unknown }>
            | undefined;
          expect(messages?.[0]?.content).toBe("hello");
          return Response.json({
            choices: [{ message: { content: "world" } }],
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    // Drive the adapter against the fetch mock directly while keeping
    // hasLoadedModel() true with a lightweight test child placeholder.
    class TestMlx extends MlxLocalServer {
      attach(baseUrl: string, modelName: string) {
        this.baseUrl = baseUrl;
        this.servedModelName = modelName;
        this.child = { killed: false, pid: 1 } as never;
        this.modelDir = "/fake/mlx/model";
      }
    }
    const t = new TestMlx();
    svc = t;
    t.attach("http://mlx.test", "eliza-1-0_8b-mlx");
    expect(t.hasLoadedModel()).toBe(true);
    const out = await t.generate({ prompt: "hello" } as never);
    expect(out).toBe("world");
  });

  it("streams SSE deltas through onTextChunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(["foo", " bar"])),
    );
    class TestMlx extends MlxLocalServer {
      attach(baseUrl: string) {
        this.baseUrl = baseUrl;
        this.servedModelName = "m";
        this.child = spawn(process.execPath, [
          "-e",
          "setInterval(() => {}, 1000)",
        ]);
        this.modelDir = "/fake";
      }
    }
    const t = new TestMlx();
    svc = t;
    t.attach("http://mlx.test");
    const chunks: string[] = [];
    const out = await t.generate({
      prompt: "x",
      onTextChunk: (c: string) => {
        chunks.push(c);
      },
    } as never);
    expect(chunks).toEqual(["foo", " bar"]);
    expect(out).toBe("foo bar");
  });
});
