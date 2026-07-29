/**
 * Verifies host-agent model provisioning and fail-fast readiness for the iOS local-chat smoke.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalArgv = process.argv;
const originalModelSize = process.env.ANDROID_SMOKE_MODEL_SIZE_BYTES;
const originalHostModelSha = process.env.ELIZA_HOST_AGENT_SMOKE_MODEL_SHA256;
process.env.ANDROID_SMOKE_MODEL_SIZE_BYTES = "4";
process.env.ELIZA_HOST_AGENT_SMOKE_MODEL_SHA256 = createHash("sha256")
  .update("gguf")
  .digest("hex");
process.argv = [
  "bun",
  "mobile-local-chat-provisioning.test.mjs",
  "--platform",
  "unit-test",
];
const smoke = await import(
  `./mobile-local-chat-smoke.mjs?provisioning-test=${Date.now()}`
);
process.argv = originalArgv;

beforeAll(() => {
  process.env.ANDROID_SMOKE_MODEL_SIZE_BYTES = "4";
  process.env.ELIZA_HOST_AGENT_SMOKE_MODEL_SHA256 = createHash("sha256")
    .update("gguf")
    .digest("hex");
});

afterAll(() => {
  if (originalModelSize === undefined) {
    delete process.env.ANDROID_SMOKE_MODEL_SIZE_BYTES;
  } else {
    process.env.ANDROID_SMOKE_MODEL_SIZE_BYTES = originalModelSize;
  }
  if (originalHostModelSha === undefined) {
    delete process.env.ELIZA_HOST_AGENT_SMOKE_MODEL_SHA256;
  } else {
    process.env.ELIZA_HOST_AGENT_SMOKE_MODEL_SHA256 = originalHostModelSha;
  }
});

describe("iOS host-agent local-inference provisioning", () => {
  it("stages a production-readable model registry and assignments", async () => {
    const sourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-host-model-source-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-host-model-state-"),
    );
    try {
      const source = path.join(sourceDir, "model.gguf");
      fs.writeFileSync(source, "gguf");
      const staged = await smoke.stageHostAgentSmokeModel(source, stateDir);
      const localInferenceRoot = path.join(stateDir, "local-inference");
      const registry = JSON.parse(
        fs.readFileSync(path.join(localInferenceRoot, "registry.json"), "utf8"),
      );
      const assignments = JSON.parse(
        fs.readFileSync(
          path.join(localInferenceRoot, "assignments.json"),
          "utf8",
        ),
      );

      expect(fs.readFileSync(staged.modelPath, "utf8")).toBe("gguf");
      expect(registry).toMatchObject({
        version: 1,
        models: [
          {
            id: "eliza-1-2b",
            path: "models/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf",
            source: "eliza-download",
            lastUsedAt: null,
            runtimeClass: "fused-eliza1",
          },
        ],
      });
      expect(registry.models[0]).not.toHaveProperty("bundleVerifiedAt");
      expect(assignments).toEqual({
        version: 1,
        assignments: {
          TEXT_SMALL: "eliza-1-2b",
          TEXT_LARGE: "eliza-1-2b",
        },
      });

      const previousStateDir = process.env.ELIZA_STATE_DIR;
      process.env.ELIZA_STATE_DIR = stateDir;
      try {
        const [{ listInstalledModels }, { readAssignments }] =
          await Promise.all([
            import(
              `../../../plugins/plugin-local-inference/src/services/registry.ts?provisioning-test=${Date.now()}`
            ),
            import(
              `../../../plugins/plugin-local-inference/src/services/assignments.ts?provisioning-test=${Date.now()}`
            ),
          ]);
        await expect(listInstalledModels()).resolves.toMatchObject([
          {
            id: "eliza-1-2b",
            path: staged.modelPath,
            runtimeClass: "fused-eliza1",
          },
        ]);
        await expect(readAssignments()).resolves.toEqual({
          TEXT_SMALL: "eliza-1-2b",
          TEXT_LARGE: "eliza-1-2b",
        });
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.ELIZA_STATE_DIR;
        } else {
          process.env.ELIZA_STATE_DIR = previousStateDir;
        }
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("rejects a same-size model that does not match the pinned digest", async () => {
    const sourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-host-model-source-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-host-model-state-"),
    );
    try {
      const source = path.join(sourceDir, "model.gguf");
      fs.writeFileSync(source, "nope");
      await expect(
        smoke.stageHostAgentSmokeModel(source, stateDir),
      ).rejects.toThrow(/did not match the expected size\/hash/);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("activates the staged host model with a bounded context", async () => {
    let activationBody;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        activationBody = await request.json();
        return Response.json({
          modelId: activationBody.modelId,
          modelPath: "/models/eliza-1-2b.gguf",
          status: "ready",
        });
      },
    });
    try {
      await expect(
        smoke.activateHostAgentSmokeModel(
          server.url.toString().replace(/\/$/, ""),
          "secret",
        ),
      ).resolves.toMatchObject({
        modelId: "eliza-1-2b",
        status: "ready",
      });
      expect(activationBody).toEqual({
        modelId: "eliza-1-2b",
        overrides: { contextSize: 4096 },
      });
    } finally {
      server.stop(true);
    }
  });

  it("fails on the first readiness snapshot without a model or download", async () => {
    let hubRequests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/local-inference/hub") {
          hubRequests += 1;
          return Response.json({
            installed: [],
            downloads: [],
            active: { modelId: null, status: "idle" },
          });
        }
        return new Response("missing", { status: 404 });
      },
    });
    try {
      await expect(
        smoke.requireLocalInferenceReady(
          server.url.toString().replace(/\/$/, ""),
        ),
      ).rejects.toThrow(/no installed model and no download in progress/);
      expect(hubRequests).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
