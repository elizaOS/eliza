import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  let server: http.Server | null = null;
  let svc: MlxLocalServer | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.unload();
      svc = null;
    }
    if (server) {
      await new Promise<void>((r) => server?.close(() => r()));
      server = null;
    }
  });

  it("health-checks /v1/models and routes /v1/chat/completions (non-streaming)", async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "eliza-1-0_8b-mlx" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          expect(parsed.model).toBe("eliza-1-0_8b-mlx");
          expect(parsed.messages?.[0]?.content).toBe("hello");
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "world" } }],
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const port = (server?.address() as AddressInfo).port;

    // Drive the adapter against the mock HTTP server directly (no spawn): the
    // class exposes the route/health logic, so we point baseUrl at the mock by
    // calling the private fields through a tiny subclass shim.
    class TestMlx extends MlxLocalServer {
      attach(baseUrl: string, modelName: string) {
        // @ts-expect-error — test-only access to private route state
        this.baseUrl = baseUrl;
        // @ts-expect-error
        this.servedModelName = modelName;
        // @ts-expect-error — a fake child so hasLoadedModel() returns true
        this.child = { killed: false, pid: 1 } as never;
        // @ts-expect-error
        this.modelDir = "/fake/mlx/model";
      }
    }
    const t = new TestMlx();
    svc = t;
    t.attach(`http://127.0.0.1:${port}`, "eliza-1-0_8b-mlx");
    expect(t.hasLoadedModel()).toBe(true);
    const out = await t.generate({ prompt: "hello" } as never);
    expect(out).toBe("world");
  });

  it("streams SSE deltas through onTextChunk", async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        res.setHeader("content-type", "text/event-stream");
        res.write('data: {"choices":[{"delta":{"content":"foo"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" bar"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const port = (server?.address() as AddressInfo).port;
    class TestMlx extends MlxLocalServer {
      attach(baseUrl: string) {
        // @ts-expect-error
        this.baseUrl = baseUrl;
        // @ts-expect-error
        this.servedModelName = "m";
        // @ts-expect-error
        this.child = { killed: false, pid: 1 } as never;
        // @ts-expect-error
        this.modelDir = "/fake";
      }
    }
    const t = new TestMlx();
    svc = t;
    t.attach(`http://127.0.0.1:${port}`);
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
