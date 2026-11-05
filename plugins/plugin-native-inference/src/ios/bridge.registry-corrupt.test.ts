/**
 * A corrupt `registry.json` must not be reported (and then persisted) as "no
 * installed models".
 *
 * `readJsonObjectFile` answers `{}` for an absent file and for an unparseable
 * one, so `POST /api/local-inference/downloads` accepted the request, and the
 * `upsertInstalledModel` step that runs when the download completes rewrote the
 * registry from that collapsed empty state — every other installed model's
 * entry in the unparseable file was dropped. Only ENOENT means "nothing is
 * installed yet".
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MobileFsGlobals } from "../shared/fs-sandbox.ts";
import { handleDirectCoreRoute, type IosBridgeBackend } from "./bridge.ts";

const savedStateDir = process.env.ELIZA_STATE_DIR;
const tempDirs: string[] = [];
/** A registry file cut off mid-write: valid prefix, no closing brackets. */
const TRUNCATED_REGISTRY =
  '{"version":1,"models":[{"id":"eliza-1-2b","path":"models/text/eliza-1-2b-128k.gguf"';

const fsGlobals = globalThis as MobileFsGlobals;
let previousResolver: MobileFsGlobals["__ELIZA_MOBILE_FS_RESOLVE__"];

beforeEach(() => {
  // The iOS host installs this resolver at boot; pass paths through unchanged
  // so the route runs against real files in a temp state dir.
  previousResolver = fsGlobals.__ELIZA_MOBILE_FS_RESOLVE__;
  fsGlobals.__ELIZA_MOBILE_FS_RESOLVE__ = (inputPath) => inputPath;
});

afterEach(() => {
  fsGlobals.__ELIZA_MOBILE_FS_RESOLVE__ = previousResolver;
  if (savedStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = savedStateDir;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function useStateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ios-bridge-registry-"));
  tempDirs.push(dir);
  process.env.ELIZA_STATE_DIR = dir;
  return dir;
}

function localInferenceDir(stateDir: string): string {
  return path.join(stateDir, "local-inference");
}

function registryPath(stateDir: string): string {
  return path.join(localInferenceDir(stateDir), "registry.json");
}

function backend(): IosBridgeBackend {
  return {
    runtime: {} as IAgentRuntime,
    dispatchRoute: async () => null,
    cloudInferenceRejection: () => null,
    conversations: new Map(),
    close: async () => {},
  };
}

async function postDownload(
  modelId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleDirectCoreRoute(
    backend(),
    "POST",
    "/api/local-inference/downloads",
    { body: JSON.stringify({ modelId }) },
  );
  if (!res) throw new Error("route returned null");
  return { status: res.status, json: JSON.parse(res.body) };
}

describe("iOS bridge — installed-model registry storage", () => {
  it("refuses to start a download that would overwrite an unparseable registry", async () => {
    const stateDir = useStateDir();
    const filePath = registryPath(stateDir);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, TRUNCATED_REGISTRY);

    const result = await postDownload("eliza-1-2b");

    expect(result.status).not.toBe(200);
    expect(result.json.code).toBe("ios_local_models_unreadable");
    // The damaged bytes are preserved for recovery instead of being replaced
    // by the empty model list the read collapsed them into.
    expect(readFileSync(filePath, "utf8")).toBe(TRUNCATED_REGISTRY);
  });

  it("still accepts a download when the registry is only an empty map", async () => {
    const stateDir = useStateDir();
    const filePath = registryPath(stateDir);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: 1, models: [] }));

    const result = await postDownload("not-a-catalog-model");

    // The registry guard passed and the catalog check is what rejected it.
    expect(result.status).toBe(400);
    expect(String(result.json.error)).toContain("Unsupported iOS local model");
  });

  it("reports an already-installed model instead of re-downloading it", async () => {
    const stateDir = useStateDir();
    const filePath = registryPath(stateDir);
    const modelFile = path.join(
      localInferenceDir(stateDir),
      "models",
      "text",
      "eliza-1-2b-128k.gguf",
    );
    mkdirSync(path.dirname(modelFile), { recursive: true });
    writeFileSync(modelFile, "GGUF");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "eliza-1-2b",
            path: "models/text/eliza-1-2b-128k.gguf",
            sizeBytes: 4,
          },
        ],
      }),
    );

    const result = await postDownload("eliza-1-2b");

    expect(result.status).toBe(200);
    expect((result.json.job as Record<string, unknown>).state).toBe(
      "completed",
    );
  });
});
