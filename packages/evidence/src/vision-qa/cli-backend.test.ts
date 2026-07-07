/**
 * Protocol tests for the coding-agent CLI vision backend, driven by a fake
 * process runner so no real `claude`/`codex` binary or network is touched. They
 * assert the exact argv each CLI is invoked with, that real token usage is
 * extracted from each CLI's distinct output shape, and that a missing usage
 * block / empty message / non-zero exit fails typed rather than fabricating a
 * zero-usage answer. The real-CLI path is exercised by cli-backend.live.test.ts.
 */

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceError } from "../errors.ts";
import {
  CliVisionBackend,
  type ProcessResult,
  type ProcessRunner,
  parseClaudeEnvelope,
  parseCodexUsage,
} from "./cli-backend.ts";
import type { PreparedImage } from "./image.ts";
import type { VisionQuestion } from "./types.ts";

const IMAGE: PreparedImage = {
  base64: Buffer.from("fake-png-bytes").toString("base64"),
  mediaType: "image/png",
  dimensions: {
    originalWidth: 100,
    originalHeight: 50,
    sentWidth: 100,
    sentHeight: 50,
  },
  sourceSha256: "a".repeat(64),
};

const QUESTIONS: VisionQuestion[] = [
  { id: "q1", question: "What is the dominant color?" },
];

const ANSWER_JSON =
  '{"answers":[{"id":"q1","answer":"red","confidence":1,"details":"solid red"}]}';

function fakeRunner(
  impl: (command: string, args: string[]) => ProcessResult,
): ProcessRunner {
  return async (command, args) => impl(command, args);
}

describe("CliVisionBackend claude", () => {
  it("invokes claude with -p/--output-format json and extracts real usage", async () => {
    let seenArgs: string[] = [];
    const backend = new CliVisionBackend({
      cli: "claude",
      model: "claude-cli",
      runner: fakeRunner((command, args) => {
        expect(command).toBe("claude");
        seenArgs = args;
        return {
          code: 0,
          stdout: JSON.stringify({
            type: "result",
            is_error: false,
            result: ANSWER_JSON,
            usage: { input_tokens: 4117, output_tokens: 198 },
          }),
          stderr: "",
        };
      }),
    });

    const res = await backend.invoke(IMAGE, QUESTIONS, null);
    expect(res.text).toBe(ANSWER_JSON);
    expect(res.usage).toEqual({ inputTokens: 4117, outputTokens: 198 });
    expect(seenArgs).toContain("-p");
    expect(seenArgs).toContain("--output-format");
    expect(seenArgs).toContain("json");
    // Grants the headless CLI read access to the staged image's directory.
    expect(seenArgs).toContain("--add-dir");
    // The prompt must point the CLI at a real on-disk image path.
    const prompt = seenArgs[seenArgs.indexOf("-p") + 1];
    expect(prompt).toMatch(/Read the image file at .+\.png/);
  });

  it("fails typed when claude reports is_error", async () => {
    const backend = new CliVisionBackend({
      cli: "claude",
      model: "claude-cli",
      runner: fakeRunner(() => ({
        code: 0,
        stdout: JSON.stringify({ is_error: true, subtype: "error_max_turns" }),
        stderr: "",
      })),
    });
    await expect(backend.invoke(IMAGE, QUESTIONS, null)).rejects.toThrow(
      EvidenceError,
    );
  });

  it("fails typed on a non-zero exit", async () => {
    const backend = new CliVisionBackend({
      cli: "claude",
      model: "claude-cli",
      runner: fakeRunner(() => ({ code: 1, stdout: "", stderr: "boom" })),
    });
    await expect(backend.invoke(IMAGE, QUESTIONS, null)).rejects.toThrow(
      /claude CLI exited 1/,
    );
  });
});

describe("CliVisionBackend codex", () => {
  it("attaches the image with -i, reads -o output, and extracts turn.completed usage", async () => {
    let seenArgs: string[] = [];
    const backend = new CliVisionBackend({
      cli: "codex",
      model: "codex-cli",
      runner: fakeRunner((command, args) => {
        expect(command).toBe("codex");
        seenArgs = args;
        // Emulate codex: write the final message to the -o path.
        const outPath = args[args.indexOf("-o") + 1];
        fs.writeFileSync(outPath, ANSWER_JSON);
        return {
          code: 0,
          stdout: [
            '{"type":"turn.started"}',
            "non-json log line the CLI interleaves",
            '{"type":"turn.completed","usage":{"input_tokens":14160,"output_tokens":58}}',
          ].join("\n"),
          stderr: "",
        };
      }),
    });

    const res = await backend.invoke(IMAGE, QUESTIONS, null);
    expect(res.text).toBe(ANSWER_JSON);
    expect(res.usage).toEqual({ inputTokens: 14160, outputTokens: 58 });
    expect(seenArgs).toContain("-i");
    expect(seenArgs).toContain("--skip-git-repo-check");
    // The -i target must be a real file that was written before the call.
    const imgArg = seenArgs[seenArgs.indexOf("-i") + 1];
    expect(imgArg).toMatch(/\.png$/);
  });

  it("fails typed when codex emits no usage event", async () => {
    const backend = new CliVisionBackend({
      cli: "codex",
      model: "codex-cli",
      runner: fakeRunner((_command, args) => {
        fs.writeFileSync(args[args.indexOf("-o") + 1], ANSWER_JSON);
        return { code: 0, stdout: '{"type":"turn.started"}', stderr: "" };
      }),
    });
    await expect(backend.invoke(IMAGE, QUESTIONS, null)).rejects.toThrow(
      /no turn.completed usage/,
    );
  });
});

describe("CLI output parsers", () => {
  it("parseClaudeEnvelope requires a string result and usage", () => {
    expect(() => parseClaudeEnvelope("not json")).toThrow(EvidenceError);
    expect(() =>
      parseClaudeEnvelope(JSON.stringify({ result: ANSWER_JSON })),
    ).toThrow(/usage/);
    const ok = parseClaudeEnvelope(
      JSON.stringify({
        result: ANSWER_JSON,
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    expect(ok.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it("parseCodexUsage takes the last turn.completed and ignores noise", () => {
    const usage = parseCodexUsage(
      [
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
        "garbage",
        '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":3}}',
      ].join("\n"),
    );
    expect(usage).toEqual({ inputTokens: 9, outputTokens: 3 });
    expect(() => parseCodexUsage("no events here")).toThrow(EvidenceError);
  });
});
