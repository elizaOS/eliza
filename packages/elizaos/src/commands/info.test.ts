/**
 * Info command tests drive the real template manifest. Named lookups that
 * cannot be satisfied must exit 1; previously-valid listings stay byte-identical.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { info } from "./info.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function captureInfo(fn: () => void): {
  code: number | null;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    stdout.push(args.map(String).join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.map(String).join(" "));
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  let code: number | null = null;
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const matched = /^exit:(\d+)$/.exec(message);
    if (!matched) {
      throw err;
    }
    code = Number(matched[1]);
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { code, stdout, stderr };
}

describe("info command", () => {
  it("exits 1 and does not print an empty JSON array for an unknown template", () => {
    const result = captureInfo(() =>
      info({ json: true, template: "does-not-exist" }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout.join("\n")).not.toBe("[]");
    const parsed = JSON.parse(result.stdout.join("\n")) as { error: string };
    expect(parsed.error).toContain("Template 'does-not-exist' not found.");
  });

  it("exits 1 for an unknown template in human output", () => {
    const result = captureInfo(() => info({ template: "does-not-exist" }));

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "Template 'does-not-exist' not found.",
    );
    expect(result.stdout.join("\n")).not.toContain("elizaOS Templates");
  });

  it("exits 1 when a named template does not support the requested language", () => {
    const result = captureInfo(() =>
      info({ json: true, language: "python", template: "plugin" }),
    );

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout.join("\n")) as { error: string };
    expect(parsed.error).toContain("does not support language 'python'");
  });

  it("keeps a language-only filter that matches nothing as an empty listing", () => {
    const result = captureInfo(() => info({ json: true, language: "python" }));

    expect(result.code).toBeNull();
    expect(result.stdout.join("\n")).toBe("[]");
  });

  it.each([
    [
      "all templates",
      { json: true },
      "d940239cd78ec0731abf792cc9b38fe755b04fe121475308c96825ddd9f4906c",
    ],
    [
      "plugin id",
      { json: true, template: "plugin" },
      "2f502f3339a93fa4b59c52876d8d606e462364c631b8322ba9859209eaf4193f",
    ],
    [
      "project id",
      { json: true, template: "project" },
      "b4a1d20a0c782f1801ada305bdd094575106e7f83e8a915e3ac1c0a2e7c9a590",
    ],
    [
      "typescript language filter",
      { json: true, language: "typescript" },
      "d940239cd78ec0731abf792cc9b38fe755b04fe121475308c96825ddd9f4906c",
    ],
    [
      "plugin plus typescript",
      { json: true, language: "typescript", template: "plugin" },
      "2f502f3339a93fa4b59c52876d8d606e462364c631b8322ba9859209eaf4193f",
    ],
  ] as const)(
    "preserves origin JSON bytes for %s",
    (_name, options, digest) => {
      const result = captureInfo(() => info(options));

      expect(result.code).toBeNull();
      expect(sha256(result.stdout.join("\n"))).toBe(digest);
    },
  );
});
