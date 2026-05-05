import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleVastTrainingRoutes } from "../src/routes/training-vast-routes.js";
import {
  VastTrainingService,
  type VastTrainingServiceOptions,
} from "../src/services/training-vast-service.js";
import {
  inferenceStatsPath,
  VastJobStore,
} from "../src/services/vast-job-store.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeReq(
  method: string,
  url: string,
  body?: unknown,
): {
  req: import("http").IncomingMessage;
  res: import("http").ServerResponse;
  bodyBuffer: { status: number; payload: unknown };
} {
  const headers: Record<string, string> = { host: "127.0.0.1" };
  let payloadString = "";
  if (body !== undefined) {
    payloadString = JSON.stringify(body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payloadString));
  }
  const reqEmitter = new EventEmitter() as import("http").IncomingMessage;
  reqEmitter.method = method;
  reqEmitter.url = url;
  (reqEmitter as unknown as { headers: Record<string, string> }).headers =
    headers;
  setImmediate(() => {
    if (payloadString) reqEmitter.emit("data", Buffer.from(payloadString));
    reqEmitter.emit("end");
  });

  const captured: { status: number; payload: unknown } = {
    status: 0,
    payload: null,
  };
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((chunk?: string) => {
      captured.status = (res as unknown as { statusCode: number }).statusCode;
      if (chunk) {
        try {
          captured.payload = JSON.parse(chunk);
        } catch {
          captured.payload = chunk;
        }
      }
    }),
  } as unknown as import("http").ServerResponse;
  return { req: reqEmitter, res, bodyBuffer: captured };
}

const REGISTRY_FIXTURE = {
  "qwen3.5-2b": {
    eliza_short_name: "eliza-1-2b",
    eliza_repo_id: "elizaOS/eliza-1-2b",
    gguf_repo_id: "elizaOS/eliza-1-2b-gguf",
    base_hf_id: "Qwen/Qwen3.5-2B",
    tier: "small",
    inference_max_context: 32768,
  },
};

let tmpRoot: string;
let prevState: string | undefined;
let prevStatsPath: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "milady-vast-test-"));
  prevState = process.env.MILADY_STATE_DIR;
  prevStatsPath = process.env.MILADY_INFERENCE_STATS_PATH;
  process.env.MILADY_STATE_DIR = tmpRoot;
  process.env.ELIZA_STATE_DIR = tmpRoot;
});

afterEach(() => {
  if (prevState === undefined) delete process.env.MILADY_STATE_DIR;
  else process.env.MILADY_STATE_DIR = prevState;
  if (prevStatsPath === undefined)
    delete process.env.MILADY_INFERENCE_STATS_PATH;
  else process.env.MILADY_INFERENCE_STATS_PATH = prevStatsPath;
  delete process.env.ELIZA_STATE_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function buildServiceWithSpawn(opts: {
  registryStdout?: string;
  registryFails?: boolean;
  trainExitCode?: number;
  evalExitCode?: number;
}): {
  service: VastTrainingService;
  spawnCalls: Array<{ command: string; args: string[] }>;
  trainChild: FakeChild;
} {
  const trainChild = makeFakeChild();
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnImpl = vi.fn((command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    const child = makeFakeChild();
    const lastArg = args[args.length - 1] ?? "";
    const isRegistryDump = lastArg.endsWith("dump_registry_json.py");
    const isEval = args.some((a) => a.endsWith("eval_checkpoint.py"));
    const isTrain = args.some((a) => a.endsWith("train_vast.sh"));
    setImmediate(() => {
      if (isRegistryDump) {
        if (opts.registryFails) {
          child.stderr.emit("data", Buffer.from("registry boom"));
          child.emit("close", 1);
          return;
        }
        child.stdout.emit(
          "data",
          Buffer.from(opts.registryStdout ?? JSON.stringify(REGISTRY_FIXTURE)),
        );
        child.emit("close", 0);
        return;
      }
      if (isTrain) {
        // Re-route the train spawn into the externally-visible trainChild
        // so the test can drive its lifecycle manually if needed.
        trainChild.stdout.on("data", (c: Buffer) =>
          child.stdout.emit("data", c),
        );
        trainChild.stderr.on("data", (c: Buffer) =>
          child.stderr.emit("data", c),
        );
        trainChild.on("close", (code) => child.emit("close", code));
        // Default: emit a fake instance id line and exit successfully.
        setImmediate(() => {
          trainChild.stdout.emit(
            "data",
            Buffer.from("MILADY_VAST_INSTANCE_ID=fake-12345\n"),
          );
          trainChild.emit("close", opts.trainExitCode ?? 0);
        });
        return;
      }
      if (isEval) {
        child.emit("close", opts.evalExitCode ?? 0);
        return;
      }
      child.emit("close", 0);
    });
    return child as unknown as ReturnType<typeof import("child_process").spawn>;
  });
  const serviceOpts: VastTrainingServiceOptions = {
    trainingRoot: "/home/shaw/milady/eliza/packages/training",
    pythonLauncher: { command: "python", preArgs: [] },
    spawnImpl: spawnImpl as unknown as VastTrainingServiceOptions["spawnImpl"],
    store: new VastJobStore(),
  };
  return {
    service: new VastTrainingService(serviceOpts),
    spawnCalls: calls,
    trainChild,
  };
}

const helpers = {
  json: (
    res: import("http").ServerResponse,
    data: unknown,
    status = 200,
  ): void => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  },
  error: (
    res: import("http").ServerResponse,
    message: string,
    status = 400,
  ): void => {
    res.statusCode = status;
    res.end(JSON.stringify({ error: message }));
  },
  readJsonBody: async <T extends object>(
    req: import("http").IncomingMessage,
  ): Promise<T | null> => {
    return await new Promise<T | null>((resolveRead) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        if (!raw) {
          resolveRead(null);
          return;
        }
        try {
          resolveRead(JSON.parse(raw) as T);
        } catch {
          resolveRead(null);
        }
      });
    });
  },
};

describe("vast training routes", () => {
  it("creates a job and persists it across store reloads", async () => {
    const { service } = buildServiceWithSpawn({});
    const { req, res, bodyBuffer } = makeReq(
      "POST",
      "/api/training/vast/jobs",
      { registry_key: "qwen3.5-2b", epochs: 1 },
    );
    const handled = await handleVastTrainingRoutes({
      req,
      res,
      method: "POST",
      pathname: "/api/training/vast/jobs",
      service,
      ...helpers,
    });
    expect(handled).toBe(true);
    expect(bodyBuffer.status).toBe(201);
    const payload = bodyBuffer.payload as {
      job_id: string;
      run_name: string;
      status: string;
    };
    expect(payload.job_id).toMatch(/^vjob_/);
    expect(payload.run_name).toBe("qwen3-5-2b-apollo");
    expect(payload.status).toBe("queued");
    // Wait one tick so the dispatch fires.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const reloadStore = new VastJobStore();
    const fromDisk = await reloadStore.list();
    expect(fromDisk.find((j) => j.job_id === payload.job_id)).toBeTruthy();
  });

  it("rejects unknown registry keys before spawning anything", async () => {
    const { service, spawnCalls } = buildServiceWithSpawn({});
    const { req, res, bodyBuffer } = makeReq(
      "POST",
      "/api/training/vast/jobs",
      { registry_key: "totally-fake", epochs: 1 },
    );
    await handleVastTrainingRoutes({
      req,
      res,
      method: "POST",
      pathname: "/api/training/vast/jobs",
      service,
      ...helpers,
    });
    expect(bodyBuffer.status).toBe(400);
    // Only the registry-dump spawn should have happened (no train_vast.sh).
    const trainCalls = spawnCalls.filter((c) =>
      c.args.some((a) => a.endsWith("train_vast.sh")),
    );
    expect(trainCalls).toHaveLength(0);
  });

  it("rejects shell-injection attempts via registry_key", async () => {
    const { service } = buildServiceWithSpawn({});
    const { req, res, bodyBuffer } = makeReq(
      "POST",
      "/api/training/vast/jobs",
      { registry_key: "qwen3.5-2b; rm -rf /", epochs: 1 },
    );
    await handleVastTrainingRoutes({
      req,
      res,
      method: "POST",
      pathname: "/api/training/vast/jobs",
      service,
      ...helpers,
    });
    expect(bodyBuffer.status).toBe(400);
  });

  it("returns 503 when eval_checkpoint.py is missing", async () => {
    // Build an isolated training root that has dump_registry_json.py but no
    // eval_checkpoint.py — simulates the CheckpointSyncAgent contract not
    // having landed yet.
    const fakeRoot = mkdtempSync(join(tmpdir(), "milady-vast-eval-"));
    mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
    writeFileSync(
      join(fakeRoot, "scripts", "dump_registry_json.py"),
      "# placeholder for the test\n",
      "utf8",
    );
    try {
      const evalService = new VastTrainingService({
        trainingRoot: fakeRoot,
        pythonLauncher: { command: "python", preArgs: [] },
        spawnImpl: ((_command: string, args: readonly string[]) => {
          const child = makeFakeChild();
          if (args[args.length - 1]?.endsWith("dump_registry_json.py")) {
            setImmediate(() => {
              child.stdout.emit(
                "data",
                Buffer.from(JSON.stringify(REGISTRY_FIXTURE)),
              );
              child.emit("close", 0);
            });
          } else {
            setImmediate(() => child.emit("close", 0));
          }
          return child as unknown as ReturnType<
            typeof import("child_process").spawn
          >;
        }) as unknown as VastTrainingServiceOptions["spawnImpl"],
        store: new VastJobStore(),
      });
      const created = await evalService.createJob({
        registry_key: "qwen3.5-2b",
        epochs: 1,
      });
      const { req, res, bodyBuffer } = makeReq(
        "POST",
        `/api/training/vast/jobs/${created.job_id}/eval`,
        {},
      );
      await handleVastTrainingRoutes({
        req,
        res,
        method: "POST",
        pathname: `/api/training/vast/jobs/${created.job_id}/eval`,
        service: evalService,
        ...helpers,
      });
      expect(bodyBuffer.status).toBe(503);
      expect((bodyBuffer.payload as { error: string }).error).toMatch(
        /eval_checkpoint\.py not found/,
      );
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("returns the registry from the dump script", async () => {
    const { service } = buildServiceWithSpawn({});
    const { req, res, bodyBuffer } = makeReq(
      "GET",
      "/api/training/vast/models",
    );
    await handleVastTrainingRoutes({
      req,
      res,
      method: "GET",
      pathname: "/api/training/vast/models",
      service,
      ...helpers,
    });
    expect(bodyBuffer.status).toBe(200);
    const payload = bodyBuffer.payload as {
      entries: Array<{ short_name: string }>;
    };
    expect(payload.entries.map((e) => e.short_name)).toContain("qwen3.5-2b");
  });

  it("aggregates inference stats from JSONL", async () => {
    const statsPath = inferenceStatsPath();
    writeFileSync(
      statsPath,
      [
        JSON.stringify({
          ts: new Date().toISOString(),
          label: "h200",
          tokens_per_sec: 100,
          p50_tpot_ms: 10,
          p95_tpot_ms: 20,
          kv_cache_usage_pct: 0.5,
          num_requests_running: 1,
          spec_decode_accept_rate: 0.8,
          apc_hit_rate: 0.9,
          peak_vram_mb: 60000,
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          label: "h200",
          tokens_per_sec: 200,
          p50_tpot_ms: 12,
          p95_tpot_ms: 30,
          kv_cache_usage_pct: 0.6,
          num_requests_running: 2,
          spec_decode_accept_rate: 0.7,
          apc_hit_rate: 0.95,
          peak_vram_mb: 65000,
        }),
        // Error row should be skipped:
        JSON.stringify({
          ts: new Date().toISOString(),
          label: "h200",
          error: "boom",
        }),
      ].join("\n"),
      "utf8",
    );
    const { service } = buildServiceWithSpawn({});
    const { req, res, bodyBuffer } = makeReq(
      "GET",
      "/api/training/vast/inference/stats?label=h200&last_minutes=30",
    );
    await handleVastTrainingRoutes({
      req,
      res,
      method: "GET",
      pathname: "/api/training/vast/inference/stats",
      service,
      ...helpers,
    });
    expect(bodyBuffer.status).toBe(200);
    const payload = bodyBuffer.payload as {
      sample_count: number;
      tokens_per_sec_avg: number;
      p95_tpot_ms_max: number;
      peak_vram_mb_max: number;
    };
    expect(payload.sample_count).toBe(2);
    expect(payload.tokens_per_sec_avg).toBe(150);
    expect(payload.p95_tpot_ms_max).toBe(30);
    expect(payload.peak_vram_mb_max).toBe(65000);
  });

  it("creates and lists inference endpoints", async () => {
    const { service } = buildServiceWithSpawn({});
    const create = makeReq("POST", "/api/training/vast/inference/endpoints", {
      label: "h200-prod",
      base_url: "http://10.0.0.5:8000",
      registry_key: "qwen3.5-2b",
    });
    await handleVastTrainingRoutes({
      req: create.req,
      res: create.res,
      method: "POST",
      pathname: "/api/training/vast/inference/endpoints",
      service,
      ...helpers,
    });
    expect(create.bodyBuffer.status).toBe(201);

    const list = makeReq("GET", "/api/training/vast/inference/endpoints");
    await handleVastTrainingRoutes({
      req: list.req,
      res: list.res,
      method: "GET",
      pathname: "/api/training/vast/inference/endpoints",
      service,
      ...helpers,
    });
    expect(list.bodyBuffer.status).toBe(200);
    const payload = list.bodyBuffer.payload as {
      endpoints: Array<{ label: string }>;
    };
    expect(payload.endpoints.map((e) => e.label)).toContain("h200-prod");
  });
});
