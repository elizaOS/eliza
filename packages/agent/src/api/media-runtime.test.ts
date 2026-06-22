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
const { collectReferencedMedia, mediaFileRoute, registerMediaPipelineHook } =
  await import("./media-runtime.ts");

type Memory = import("@elizaos/core").Memory;

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

  it("rehosts a remote media URL, marking it ephemeral when the host is blocked", async () => {
    const { runtime, getHook } = captureHookRuntime();
    registerMediaPipelineHook(runtime);
    const hook = getHook();

    const ctx = {
      phase: "outgoing_before_deliver" as const,
      content: {
        attachments: [
          {
            id: "gen",
            // Link-local host → SSRF guard blocks before any network I/O.
            url: "http://169.254.169.254/secret.png",
            contentType: "image",
          },
        ],
      },
    };
    await hook.handler(runtime, ctx);

    // Blocked rehost → keep the original URL and flag it for a UI retry.
    expect(ctx.content.attachments[0].url).toBe(
      "http://169.254.169.254/secret.png",
    );
    expect(
      (ctx.content.attachments[0] as { ephemeral?: boolean }).ephemeral,
    ).toBe(true);
  });

  it("does not rehost remote link attachments or already-stored media", async () => {
    const { runtime, getHook } = captureHookRuntime();
    registerMediaPipelineHook(runtime);
    const hook = getHook();

    const storedUrl = `/api/media/${"a".repeat(64)}.png`;
    const ctx = {
      phase: "outgoing_before_deliver" as const,
      content: {
        attachments: [
          {
            id: "link",
            url: "https://example.com/article",
            contentType: "link",
          },
          { id: "stored", url: storedUrl, contentType: "image" },
        ],
      },
    };
    await hook.handler(runtime, ctx);

    // Links are not media; stored URLs are already durable — both untouched.
    expect(ctx.content.attachments[0].url).toBe("https://example.com/article");
    expect(
      (ctx.content.attachments[0] as { ephemeral?: boolean }).ephemeral,
    ).toBeUndefined();
    expect(ctx.content.attachments[1].url).toBe(storedUrl);
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

describe("collectReferencedMedia", () => {
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);

  it("collects a file referenced only via memory.metadata.mediaUrl", () => {
    const memories = [
      {
        // Document-linked original-bytes file: no content.attachments entry.
        content: { text: "a knowledge doc" },
        metadata: { type: "document", mediaUrl: `/api/media/${HASH_A}.pdf` },
      },
    ] as unknown as Memory[];

    const referenced = collectReferencedMedia(memories);

    expect(referenced.has(`${HASH_A}.pdf`)).toBe(true);
  });

  it("collects from both content.attachments and metadata.mediaUrl", () => {
    const memories = [
      {
        content: {
          text: "msg",
          attachments: [{ url: `/api/media/${HASH_B}.png` }],
        },
        metadata: { type: "document", mediaUrl: `/api/media/${HASH_A}.pdf` },
      },
    ] as unknown as Memory[];

    const referenced = collectReferencedMedia(memories);

    expect(referenced.has(`${HASH_A}.pdf`)).toBe(true);
    expect(referenced.has(`${HASH_B}.png`)).toBe(true);
    expect(referenced.size).toBe(2);
  });

  it("ignores non-media metadata.mediaUrl values", () => {
    const memories = [
      {
        content: { text: "x" },
        metadata: { type: "document", mediaUrl: "https://example.com/x.pdf" },
      },
      { content: { text: "y" }, metadata: { type: "document" } },
    ] as unknown as Memory[];

    const referenced = collectReferencedMedia(memories);

    expect(referenced.size).toBe(0);
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
