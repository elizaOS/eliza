/**
 * Durable content store: input canonicalized ONCE (well-formed Unicode +
 * credential redaction) with sha and stored bytes derived from that canonical
 * text; windowed reads snap to UTF-8 code-point boundaries and reassemble
 * losslessly. Also covers the store's HTTP promise END-TO-END: the content
 * path must match a REGISTERED route template (setup-routes.ts) and dispatch
 * through the real route handler with strict offset/limit validation. Real
 * filesystem via the trajectory dir; the dispatcher runs against fake req/res
 * objects. The retired durableProjection substitution has no tests here —
 * model-facing surfaces carry complete content and the store is durability +
 * caller-requested retrieval only.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSensitiveText, toWellFormedUnicode } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingAgentRoutes } from "../api/routes.js";
import {
  persistDurableContent,
  readDurableContent,
} from "../services/durable-content-store.js";
import { CODING_AGENT_ROUTE_PATHS } from "../setup-routes.js";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-content-"));
  savedEnv = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = dir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

function canonicalOf(text: string): string {
  return redactSensitiveText(toWellFormedUnicode(text));
}

function shaOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Page through the record from `offset` using the store's reported actual
 *  ranges, asserting every window is self-consistent and decodes cleanly. */
function readAllFrom(sha: string, offset: number, limit: number): string {
  let out = "";
  let cursor = offset;
  for (;;) {
    const window = readDurableContent(sha, { offset: cursor, limit });
    if (!window) throw new Error("record vanished");
    // The reported range is the ACTUAL byte range served.
    expect(window.endOffset - window.offset).toBe(
      Buffer.byteLength(window.text, "utf8"),
    );
    // Each window independently decodes cleanly — no split code points.
    expect(window.text).not.toContain("�");
    out += window.text;
    if (!window.hasMore) {
      expect(window.endOffset).toBe(window.totalBytes);
      break;
    }
    expect(window.endOffset).toBeGreaterThan(cursor);
    cursor = window.endOffset;
  }
  return out;
}

describe("durable content store", () => {
  it("persists content-addressed and reads back windows losslessly", () => {
    const text = "0123456789".repeat(100);
    const ref = persistDurableContent(text);
    expect(ref.ref).toMatch(/^acpx-content:[0-9a-f]{64}$/);
    const sha = ref.ref.slice("acpx-content:".length);

    const head = readDurableContent(sha, { offset: 0, limit: 100 });
    expect(head?.text.length).toBe(100);
    expect(head?.offset).toBe(0);
    expect(head?.endOffset).toBe(100);
    expect(head?.hasMore).toBe(true);
    expect(head?.totalBytes).toBe(1000);

    // Lossless reassembly across windows.
    expect(readAllFrom(sha, 0, 333)).toBe(text);

    // Idempotent persist.
    expect(persistDurableContent(text).ref).toBe(ref.ref);
  });

  it("returns undefined for unknown or malformed refs", () => {
    expect(readDurableContent("f".repeat(64))).toBeUndefined();
    expect(readDurableContent("not-a-sha")).toBeUndefined();
    expect(readDurableContent("../escape")).toBeUndefined();
  });

  it("windows never split multibyte code points and reassemble losslessly", () => {
    // 1-byte ASCII, 2-byte é, 3-byte CJK, 4-byte emoji, and an 8-byte flag
    // (two regional indicators) so nearly every small window edge lands on a
    // continuation byte before snapping.
    const text = "中文漢字🙂🇺🇸héllo𝔘𝔫𝔦".repeat(40);
    const canonical = canonicalOf(text);
    expect(canonical).toBe(text); // no secrets, already well-formed
    const sha = persistDurableContent(text).ref.slice("acpx-content:".length);

    for (const limit of [1, 5, 7, 13, 64]) {
      expect(readAllFrom(sha, 0, limit)).toBe(canonical);
    }
  });

  it("snaps a mid-code-point requested offset forward and reports the actual range", () => {
    const text = "ab🙂cd";
    const sha = persistDurableContent(text).ref.slice("acpx-content:".length);
    const bytes = Buffer.from(text, "utf8");
    // Byte 3 is inside the 4-byte emoji (bytes 2..5).
    expect((bytes[3] as number) & 0xc0).toBe(0x80);
    const window = readDurableContent(sha, { offset: 3, limit: 100 });
    expect(window?.offset).toBe(6); // snapped past the emoji's remaining bytes
    expect(window?.text).toBe("cd");
    expect(window?.endOffset).toBe(bytes.byteLength);
    expect(window?.hasMore).toBe(false);
  });

  it("a limit smaller than the next code point serves exactly that code point", () => {
    const text = "🙂🙂"; // two 4-byte code points
    const sha = persistDurableContent(text).ref.slice("acpx-content:".length);
    const first = readDurableContent(sha, { offset: 0, limit: 1 });
    expect(first?.text).toBe("🙂");
    expect(first?.offset).toBe(0);
    expect(first?.endOffset).toBe(4);
    expect(first?.hasMore).toBe(true);
    const second = readDurableContent(sha, { offset: 4, limit: 1 });
    expect(second?.text).toBe("🙂");
    expect(second?.endOffset).toBe(8);
    expect(second?.hasMore).toBe(false);
    // Progress is guaranteed even at the minimum limit.
    expect(readAllFrom(sha, 0, 1)).toBe(text);
  });

  it("persist canonicalizes once: sha and stored bytes derive from the redacted well-formed text", () => {
    const secret = "sk-abcdef0123456789abcdef";
    const text = `API_KEY=${secret}\n\uD800tail ${"x".repeat(5000)}`;
    const canonical = canonicalOf(text);
    expect(canonical).not.toContain(secret);
    expect(canonical).toContain("\uFFFD"); // lone surrogate normalized

    const reference = persistDurableContent(text);
    const sha = reference.ref.slice("acpx-content:".length);
    expect(sha).toBe(shaOf(canonical));
    // Idempotent: same canonical text, same record.
    expect(persistDurableContent(text).ref).toBe(`acpx-content:${sha}`);

    // Stored bytes ARE the canonical text — a window can never leak what
    // storage redacted.
    const full = readDurableContent(sha, { limit: 1_048_576 });
    expect(full?.text).toBe(canonical);
    expect(full?.totalBytes).toBe(Buffer.byteLength(canonical, "utf8"));
    expect(full?.text).not.toContain(secret);
  });

  it("continuation windows reassemble a persisted record to the canonical redacted text exactly", () => {
    const secret = "sk-abcdef0123456789abcdef";
    const text = `token: "${secret}" then 中文漢字🙂🇺🇸héllo𝔘𝔫𝔦 `.repeat(60);
    const canonical = canonicalOf(text);
    expect(canonical).not.toContain(secret);

    const reference = persistDurableContent(text);
    const sha = reference.ref.slice("acpx-content:".length);
    // Small windows force snapping across the multibyte runs; every window
    // decodes cleanly and the concatenation is byte-exact canonical text.
    for (const limit of [7, 4096]) {
      const all = readAllFrom(sha, 0, limit);
      expect(all).not.toContain(secret);
      expect(all).toBe(canonical);
    }
  });
});

/** Convert a registered route template (`:param` segments) to a matcher. */
function templateToRegExp(template: string): RegExp {
  const pattern = template
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

type FakeRes = {
  statusCode: number | undefined;
  body: string;
  headersSent: boolean;
  writeHead(status: number, headers?: unknown): void;
  end(chunk?: unknown): void;
};

function makeRes(): FakeRes {
  return {
    statusCode: undefined,
    body: "",
    headersSent: false,
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") this.body += chunk;
    },
  };
}

async function dispatchGet(url: string): Promise<{
  handled: boolean;
  status: number | undefined;
  json: Record<string, unknown> | undefined;
}> {
  const req = { method: "GET", url, headers: {} };
  const res = makeRes();
  const pathname = new URL(url, "http://localhost").pathname;
  const handled = await handleCodingAgentRoutes(
    req as never,
    res as never,
    pathname,
    {
      runtime: {
        getService: () => null,
        hasService: () => false,
        getSetting: () => undefined,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      } as never,
      acpService: null,
      workspaceService: null,
    },
  );
  return {
    handled,
    status: res.statusCode,
    json: res.body
      ? (JSON.parse(res.body) as Record<string, unknown>)
      : undefined,
  };
}

describe("content continuation route (registered + end-to-end)", () => {
  it("a persisted reference's content path matches a REGISTERED route template", () => {
    const sha = persistDurableContent("y".repeat(6000)).ref.slice(
      "acpx-content:".length,
    );
    const contentPath = `/api/orchestrator/content/${sha}`;
    // Regression: the handler existed but the path was missing from the
    // registered route list, so the runtime dispatcher 404'd every reference.
    const matches = CODING_AGENT_ROUTE_PATHS.filter(
      (route) =>
        route.type === "GET" && templateToRegExp(route.path).test(contentPath),
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it("resolves a persisted reference end-to-end through the route dispatcher", async () => {
    const full = `route resolve ${"中🙂z".repeat(1500)}`;
    const sha = persistDurableContent(full).ref.slice("acpx-content:".length);
    const markerPath = `/api/orchestrator/content/${sha}`;

    let out = "";
    let cursor = 0;
    for (;;) {
      const { handled, status, json } = await dispatchGet(
        `${markerPath}?offset=${cursor}&limit=97`,
      );
      expect(handled).toBe(true);
      expect(status).toBe(200);
      const window = json as {
        text: string;
        endOffset: number;
        totalBytes: number;
        hasMore: boolean;
      };
      out += window.text;
      if (!window.hasMore) break;
      cursor = window.endOffset;
    }
    expect(out).toBe(full);
  });

  it("returns 404 for an unknown record", async () => {
    const { handled, status } = await dispatchGet(
      `/api/orchestrator/content/${"f".repeat(64)}`,
    );
    expect(handled).toBe(true);
    expect(status).toBe(404);
  });

  it("rejects non-canonical offset/limit spellings with a typed 400", async () => {
    const sha = persistDurableContent("strict query validation").ref.slice(
      "acpx-content:".length,
    );
    const badOffsets = [
      "12abc",
      "1.5",
      "+1",
      "-1",
      "01",
      "0x10",
      "1e2",
      "%201",
    ];
    for (const offset of badOffsets) {
      const { status, json } = await dispatchGet(
        `/api/orchestrator/content/${sha}?offset=${offset}`,
      );
      expect(status, `offset=${offset}`).toBe(400);
      expect(String(json?.error)).toContain("canonical decimal unsigned");
    }
    const badLimits = ["12abc", "1.5", "+1", "0"];
    for (const limit of badLimits) {
      const { status } = await dispatchGet(
        `/api/orchestrator/content/${sha}?limit=${limit}`,
      );
      expect(status, `limit=${limit}`).toBe(400);
    }
    // Canonical spellings still resolve.
    const ok = await dispatchGet(
      `/api/orchestrator/content/${sha}?offset=0&limit=8`,
    );
    expect(ok.status).toBe(200);
  });
});
