/**
 * CLI tests driving runVisionQaCli with a captured writer (no child process,
 * matching the bundle CLI's test style) against a local stub Anthropic server.
 * Covers argv parsing, the --context suggestion merge, table vs --json output,
 * and the usage/error exit codes.
 */

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVisionQaCli, type VisionQaCliIo } from "./cli.ts";

function capture(): { io: VisionQaCliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function conformingAnswers(ids: string[]): string {
  return JSON.stringify({
    answers: ids.map((id) => ({
      id,
      answer: `answer-${id}`,
      confidence: 0.9,
      details: `details-${id}`,
    })),
  });
}

/** Stub that echoes back a conforming answer for whatever ids it is asked. */
function startStub(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text: string = body.messages[0].content.find(
        (b: { type: string }) => b.type === "text",
      ).text;
      // Recover the asked ids from the rendered prompt ("id "qN"").
      const ids = [...text.matchAll(/id "([^"]+)"/g)].map((m) => m[1]);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          content: [{ type: "text", text: conformingAnswers(ids) }],
          usage: { input_tokens: 1000, output_tokens: 20 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

let dir: string;
let imagePath: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-cli-"));
  imagePath = path.join(dir, "shot.png");
  await sharp({
    create: { width: 400, height: 300, channels: 3, background: "#f0781e" },
  })
    .png()
    .toFile(imagePath);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("runVisionQaCli ask", () => {
  it("prints a readable answer table for -q questions", async () => {
    const { server, url } = await startStub();
    const { io, out } = capture();
    try {
      const code = await runVisionQaCli(
        [
          "ask",
          imagePath,
          "-q",
          "What does the button say?",
          "--backend",
          "anthropic",
          "--base-url",
          url,
          "--api-key",
          "stub-key",
          "--no-cache",
        ],
        io,
      );
      expect(code).toBe(0);
      const joined = out.join("\n");
      expect(joined).toContain("backend=anthropic");
      expect(joined).toContain("[q1] What does the button say?");
      expect(joined).toContain("answer:     answer-q1");
    } finally {
      server.close();
    }
  });

  it("emits raw JSON with --json", async () => {
    const { server, url } = await startStub();
    const { io, out } = capture();
    try {
      await runVisionQaCli(
        [
          "ask",
          imagePath,
          "-q",
          "Q?",
          "--backend",
          "anthropic",
          "--base-url",
          url,
          "--api-key",
          "stub-key",
          "--no-cache",
          "--json",
        ],
        io,
      );
      const parsed = JSON.parse(out.join("\n"));
      expect(parsed.answers[0].id).toBe("q1");
      expect(parsed.provenance.backend).toBe("anthropic");
    } finally {
      server.close();
    }
  });

  it("merges --context suggestions ahead of -q questions", async () => {
    const contextFile = path.join(dir, "analysis.json");
    fs.writeFileSync(
      contextFile,
      JSON.stringify({
        color_fractions: { blue_fraction: 0.2 },
        ocr_text: "x",
      }),
    );
    const { server, url } = await startStub();
    const { io, out } = capture();
    try {
      const code = await runVisionQaCli(
        [
          "ask",
          imagePath,
          "-q",
          "Extra question?",
          "--context",
          contextFile,
          "--view",
          "Dashboard",
          "--backend",
          "anthropic",
          "--base-url",
          url,
          "--api-key",
          "stub-key",
          "--no-cache",
        ],
        io,
      );
      expect(code).toBe(0);
      const joined = out.join("\n");
      // Suggested blue question comes first, hand-written -q after.
      expect(joined).toContain("[q-blue]");
      expect(joined).toContain("[q1] Extra question?");
    } finally {
      server.close();
    }
  });

  it("exits non-zero with usage when no image is given", async () => {
    const { io, err } = capture();
    const code = await runVisionQaCli(["ask", "-q", "hi"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("[CLI_USAGE]");
  });

  it("exits non-zero when no questions and no context are given", async () => {
    const { io, err } = capture();
    const code = await runVisionQaCli(["ask", imagePath], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no questions");
  });

  it("prints usage for an unknown subcommand", async () => {
    const { io, err } = capture();
    const code = await runVisionQaCli(["frobnicate"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Usage:");
  });
});
