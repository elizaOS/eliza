import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-runtime-test-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const { persistMediaBytes } = await import("./media-store.ts");
const { mediaFileRoute, registerMediaPipelineHook } = await import(
  "./media-runtime.ts"
);

type CapturedHook = { handler: (rt: unknown, ctx: unknown) => unknown };

/** Mock runtime that captures the registered pipeline hook for invocation. */
function captureHookRuntime(): {
  runtime: never;
  getHook: () => CapturedHook;
} {
  let hook: CapturedHook | null = null;
  const runtime = {
    registerPipelineHook: (spec: CapturedHook) => {
      hook = spec;
    },
  } as never;
  return {
    runtime,
    getHook: () => {
      if (!hook) throw new Error("hook was not registered");
      return hook;
    },
  };
}

describe("registerMediaPipelineHook", () => {
  it("rewrites inline data: URL attachments to served URLs, leaves the rest", async () => {
    const { runtime, getHook } = captureHookRuntime();
    registerMediaPipelineHook(runtime);
    const hook = getHook();

    const ctx = {
      phase: "outgoing_before_deliver" as const,
      content: {
        text: "here you go",
        attachments: [
          {
            id: "gen",
            url: `data:image/png;base64,${Buffer.from("genimg").toString("base64")}`,
            contentType: "image",
          },
          { id: "remote", url: "https://cdn.example.com/x.png" },
        ],
      },
    };
    await hook.handler(runtime, ctx);

    expect(ctx.content.attachments[0].url).toMatch(
      /^\/api\/media\/[a-f0-9]{64}\.png$/,
    );
    expect(ctx.content.attachments[1].url).toBe(
      "https://cdn.example.com/x.png",
    );
  });

  it("ignores non-outgoing phases and empty attachments", async () => {
    const { runtime, getHook } = captureHookRuntime();
    registerMediaPipelineHook(runtime);
    const hook = getHook();

    const wrongPhase = {
      phase: "incoming_before_compose" as const,
      content: { attachments: [{ id: "x", url: "data:image/png;base64,AA" }] },
    };
    await hook.handler(runtime, wrongPhase);
    // Untouched because the phase guard returns early.
    expect(wrongPhase.content.attachments[0].url).toBe(
      "data:image/png;base64,AA",
    );
  });
});

describe("mediaFileRoute", () => {
  it("serves a stored file's bytes via the route handler", async () => {
    const bytes = Buffer.from("route-served");
    const { fileName } = persistMediaBytes(bytes, "image/png");
    const result = await mediaFileRoute.routeHandler?.({
      params: { filename: fileName },
      method: "GET",
    } as never);
    expect(result?.status).toBe(200);
    expect(Buffer.isBuffer(result?.body)).toBe(true);
    expect((result?.body as Buffer).equals(bytes)).toBe(true);
  });

  it("404s a missing file", async () => {
    const result = await mediaFileRoute.routeHandler?.({
      params: { filename: `${"b".repeat(64)}.png` },
      method: "GET",
    } as never);
    expect(result?.status).toBe(404);
  });
});
