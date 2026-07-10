/**
 * Process-boundary round-trip proof for the IPC response envelope: spawns
 * `__tests__/stdio-envelope-child.ts` under a real Bun child process, writes
 * request frames to its actual stdin, reads `{ok, result}` frames from its
 * actual stdout, and asserts sha256 byte-equality of the binary body across the
 * base64 envelope — plus typed `{ok:false}` failure frames for a partial-write
 * handler and malformed declared JSON. This is the same NDJSON kernel + frame
 * shape the Android UDS bridge, iOS stdio pipe, and Electrobun local-agent
 * child use, exercised over a true OS pipe rather than an in-process call.
 *
 * The subprocess needs the installed workspace module graph (resolved from
 * sources via `--conditions=eliza-source`, no dist required). When it cannot
 * boot, the behavioral case skips explicitly on a local sparse checkout and
 * hard-fails in CI so a child-boot regression can never go green.
 */

import { Buffer } from "node:buffer";
import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

const CHILD_PATH = join(
  import.meta.dirname,
  "__tests__",
  "stdio-envelope-child.ts",
);

/**
 * Locally a missing bun / unbootable child skips with a warning (sparse
 * checkout); in CI that same skip would hide a child-boot regression behind a
 * green run, so it hard-fails there instead.
 */
function failOrSkip(reason: string): boolean {
  if (process.env.CI) {
    throw new Error(
      `[stdio-envelope] required process-boundary case cannot run in CI: ${reason}`,
    );
  }
  console.warn(`[stdio-envelope] skipping process-boundary case: ${reason}`);
  return true;
}

/** Locate a `bun` executable; the fixture imports the TS module graph. */
function resolveBunExecutable(): string | null {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return process.execPath;
  }
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const resolved = execFileSync(locator, ["bun"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // error-policy:J3 not on PATH — fall through to absolute install locations.
  }
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun") : "",
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface EnvelopeFrame {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
}

interface EnvelopeResult {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  bodyEncoding: string;
}

function isEnvelopeResult(value: unknown): value is EnvelopeResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EnvelopeResult>;
  return (
    typeof candidate.status === "number" &&
    typeof candidate.bodyBase64 === "string" &&
    typeof candidate.bodyEncoding === "string" &&
    typeof candidate.headers === "object" &&
    candidate.headers !== null
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Drive the child over its real stdio: write one request frame per path, then
 * collect the matching response frames. The child multiplexes runtime logs on
 * stdout, so only lines that parse as JSON frames with a pending numeric id
 * count — the same filtering the production Electrobun dispatcher applies.
 */
async function runEnvelopeChild(
  bun: string,
  payload: Buffer,
): Promise<Map<number, EnvelopeFrame> | { bootError: string }> {
  const requests = [
    { id: 1, path: "/api/envelope/audio" },
    { id: 2, path: "/api/envelope/partial" },
    { id: 3, path: "/api/envelope/bad-json" },
  ];
  // `--conditions=eliza-source` resolves @elizaos/* package entries to their
  // TS sources (the same condition the coverage gate's bun lane uses), so the
  // child needs no built dist.
  const child: ChildProcessWithoutNullStreams = spawn(
    bun,
    ["--conditions=eliza-source", CHILD_PATH, payload.toString("base64")],
    { env: { ...process.env, LOG_LEVEL: "error" }, stdio: "pipe" },
  );

  const frames = new Map<number, EnvelopeFrame>();
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4000);
  });

  const outcome = await new Promise<Map<number, EnvelopeFrame> | null>(
    (resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 90_000);
      const finish = (value: Map<number, EnvelopeFrame> | null): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let frame: EnvelopeFrame;
        try {
          frame = JSON.parse(line) as EnvelopeFrame;
        } catch {
          // error-policy:J3 non-JSON stdout line = child log noise, not a frame.
          return;
        }
        if (typeof frame.id !== "number") return;
        frames.set(frame.id, frame);
        if (frames.size === requests.length) {
          child.stdin.end();
          finish(frames);
        }
      });
      child.once("error", () => finish(null));
      child.once("exit", () => {
        finish(frames.size === requests.length ? frames : null);
      });
      for (const request of requests) {
        child.stdin.write(
          `${JSON.stringify({
            id: request.id,
            method: "http_request",
            payload: { method: "GET", path: request.path },
          })}\n`,
        );
      }
    },
  );
  child.kill();
  if (outcome === null) {
    return { bootError: stderrTail || "child produced no response frames" };
  }
  return outcome;
}

describe("IPC byte envelope — real child process over real stdio", () => {
  it("has the child fixture", () => {
    expect(existsSync(CHILD_PATH)).toBe(true);
  });

  it("round-trips binary bytes sha256-exact and surfaces typed failures", async () => {
    const bun = resolveBunExecutable();
    if (!bun) {
      failOrSkip("bun executable not found on this host");
      return;
    }
    // Guaranteed-invalid UTF-8 prefix + RIFF magic + random tail: any UTF-8
    // decode/re-encode on the path corrupts these bytes, so sha256 equality
    // proves the envelope is byte-exact.
    const payload = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0x80]),
      Buffer.from("RIFF", "ascii"),
      randomBytes(4096),
    ]);

    const outcome = await runEnvelopeChild(bun, payload);
    if ("bootError" in outcome) {
      // Sparse checkout: the fixture's module graph needs the installed
      // workspace. Never a silent skip in CI.
      failOrSkip(`child unavailable in this environment: ${outcome.bootError}`);
      return;
    }

    const audio = outcome.get(1);
    expect(audio?.ok).toBe(true);
    if (!isEnvelopeResult(audio?.result)) {
      throw new Error("audio frame result is not a buffered response envelope");
    }
    expect(audio.result.status).toBe(200);
    expect(audio.result.bodyEncoding).toBe("base64");
    // The mixed-case, parameterized content type must classify as binary and
    // survive the envelope untouched.
    expect(audio.result.headers["content-type"]).toBe(
      "Audio/WAV; Charset=UTF-8",
    );
    const received = Buffer.from(audio.result.bodyBase64, "base64");
    expect(received.length).toBe(payload.length);
    expect(sha256(received)).toBe(sha256(payload));

    const partial = outcome.get(2);
    expect(partial?.ok).toBe(false);
    expect(partial?.error).toBe(
      "legacy route handler threw after writing its response",
    );

    const badJson = outcome.get(3);
    expect(badJson?.ok).toBe(false);
    expect(badJson?.error).toBe(
      "legacy route declared JSON but body is malformed",
    );
  }, 120_000);
});
