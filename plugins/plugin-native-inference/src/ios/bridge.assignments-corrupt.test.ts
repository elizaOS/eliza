/**
 * A corrupt `assignments.json` must not be reported (and then persisted) as an
 * empty assignment map.
 *
 * `readJsonObjectFile` collapses "file absent" and "file unparseable" into the
 * same `{}`, so `POST /api/local-inference/assignments` answered 200 with
 * `{"assignments":{}}` and wrote that map back to disk — every other slot's
 * assignment in the unparseable file was lost and the caller had no way to see
 * that the stored state was damaged rather than empty.
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
/** An assignments file cut off mid-write: valid prefix, no closing braces. */
const TRUNCATED_ASSIGNMENTS =
  '{"version":1,"assignments":{"TEXT_LARGE":"eliza-1-2b"';

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "ios-bridge-assignments-"));
  tempDirs.push(dir);
  process.env.ELIZA_STATE_DIR = dir;
  return dir;
}

function assignmentsPath(stateDir: string): string {
  return path.join(stateDir, "local-inference", "assignments.json");
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

async function postAssignment(
  slot: string,
  modelId?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleDirectCoreRoute(
    backend(),
    "POST",
    "/api/local-inference/assignments",
    {
      body: JSON.stringify(
        modelId === undefined ? { slot } : { slot, modelId },
      ),
    },
  );
  if (!res) throw new Error("route returned null");
  return { status: res.status, json: JSON.parse(res.body) };
}

describe("iOS bridge — local model assignments storage", () => {
  it("refuses to overwrite an unparseable assignments file", async () => {
    const stateDir = useStateDir();
    const filePath = assignmentsPath(stateDir);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, TRUNCATED_ASSIGNMENTS);

    const result = await postAssignment("TEXT_SMALL");

    expect(result.status).not.toBe(200);
    expect(result.json.code).toBe("ios_local_assignments_unreadable");
    // The damaged bytes are preserved for recovery instead of being replaced
    // by the empty map the read collapsed them into.
    expect(readFileSync(filePath, "utf8")).toBe(TRUNCATED_ASSIGNMENTS);
  });

  it("still treats a missing assignments file as empty and writable", async () => {
    const stateDir = useStateDir();
    const filePath = assignmentsPath(stateDir);

    const result = await postAssignment("TEXT_SMALL");

    expect(result.status).toBe(200);
    expect(result.json.assignments).toEqual({});
    expect(JSON.parse(readFileSync(filePath, "utf8")).assignments).toEqual({});
  });
});
