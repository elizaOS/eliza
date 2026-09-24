// Video CLI argv contract and failure-path integrity. Drives runVideoCli with a
// captured IO instead of spawning a process: asserts usage on no command,
// unknown-arg / missing-required / bad-enum rejections surface as a structured
// error line + non-zero exit, and the ingest command rejects a bad granularity
// (all tool-free). Failure-path tests then prove a failed run cannot poison a
// --bundle dir (removed when unfinalized; never created for a bad --def) and —
// gated on real chromium — that a failed walkthrough preserves its scratch
// recording as failure evidence while a retry into the same --bundle succeeds.
// The happy paths' analysis details are covered by the driver and walkthroughs
// suites, not here.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CliIo, runVideoCli } from "./cli.ts";
import { serveFixture } from "./fixture-server.ts";

const dir = mkdtempSync(join(os.tmpdir(), "evidence-video-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Can we launch a real headless chromium? Gate the browser lane honestly. */
async function chromiumLaunchable(): Promise<boolean> {
  try {
    const { chromium } = (await import("@playwright/test")) as {
      chromium: { launch(o?: unknown): Promise<{ close(): Promise<void> }> };
    };
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    // error-policy:J4 test-capability gate — an absent browser download is a
    // skipped lane with a reason, not a failed test.
    return false;
  }
}

const hasChromium = await chromiumLaunchable();

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe("runVideoCli argv contract", () => {
  it("prints usage and exits 0 on --help", async () => {
    const { io, err } = capture();
    const code = await runVideoCli(["--help"], io);
    expect(code).toBe(0);
    expect(err.join("\n")).toMatch(/video:walkthrough/);
  });

  it("exits 1 on an unknown command", async () => {
    const { io } = capture();
    expect(await runVideoCli(["frobnicate"], io)).toBe(1);
  });

  it("rejects an unknown argument with a typed error line", async () => {
    const { io, err } = capture();
    const code = await runVideoCli(["walkthrough", "--nope", "x"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/\[CLI_USAGE\]/);
  });

  it("requires --def for walkthrough", async () => {
    const { io, err } = capture();
    const code = await runVideoCli(["walkthrough"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/--def/);
  });

  it("requires --file/--granularity/--slug for ingest", async () => {
    const { io, err } = capture();
    const code = await runVideoCli(["ingest", "--file", "x.webm"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/required/);
  });

  it("rejects a bad granularity for ingest", async () => {
    const { io, err } = capture();
    const code = await runVideoCli(
      ["ingest", "--file", "x.webm", "--granularity", "page", "--slug", "ok"],
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/--granularity must be one of/);
  });
});

describe("bundle poisoning on failed runs", () => {
  it("removes the unfinalized --bundle dir when ingest fails, so a retry is not blocked", async () => {
    const bundleDir = join(dir, "ingest-fail-bundle");
    const argv = [
      "ingest",
      "--file",
      join(dir, "does-not-exist.webm"),
      "--granularity",
      "feature",
      "--slug",
      "ok",
      "--bundle",
      bundleDir,
    ];

    const first = capture();
    expect(await runVideoCli(argv, first.io)).toBe(1);
    expect(first.err.join("\n")).toMatch(/VIDEO_SOURCE_MISSING/);
    expect(first.err.join("\n")).toMatch(/removed unfinalized bundle dir/);
    // The poisoned dir is gone, so the retry reports the REAL problem again
    // instead of BUNDLE_DIR_EXISTS.
    expect(existsSync(bundleDir)).toBe(false);

    const second = capture();
    expect(await runVideoCli(argv, second.io)).toBe(1);
    expect(second.err.join("\n")).toMatch(/VIDEO_SOURCE_MISSING/);
    expect(second.err.join("\n")).not.toMatch(/BUNDLE_DIR_EXISTS/);
  });

  it("does not create the --bundle dir when the walkthrough definition is invalid", async () => {
    const badDef = join(dir, "bad-def.json");
    writeFileSync(badDef, "{ this is not json");
    const bundleDir = join(dir, "bad-def-bundle");
    const { io, err } = capture();
    const code = await runVideoCli(
      ["walkthrough", "--def", badDef, "--bundle", bundleDir],
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/WALKTHROUGH_DEF_INVALID/);
    expect(existsSync(bundleDir)).toBe(false);
  });

  it("reports a typed BUNDLE_DIR_EXISTS for a pre-existing --bundle dir (sealed, no reuse)", async () => {
    const bundleDir = mkdtempSync(join(dir, "preexisting-bundle-"));
    const { io, err } = capture();
    const code = await runVideoCli(
      [
        "ingest",
        "--file",
        join(dir, "irrelevant.webm"),
        "--granularity",
        "feature",
        "--slug",
        "ok",
        "--bundle",
        bundleDir,
      ],
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/BUNDLE_DIR_EXISTS/);
    // Not ours: a pre-existing dir must never be deleted by the cleanup.
    expect(existsSync(bundleDir)).toBe(true);
  });
});

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>cli-fixture</title></head>
<body><p data-testid="msg">hello-fixture</p></body></html>`;

function defJson(slug: string, expectText: string): string {
  return JSON.stringify({
    slug,
    granularity: "feature",
    steps: [
      { action: "goto", value: "/", label: "open" },
      {
        action: "assertText",
        selector: '[data-testid="msg"]',
        value: expectText,
        label: "check",
      },
    ],
  });
}

describe.skipIf(!hasChromium)(
  "walkthrough failure path (real chromium)",
  () => {
    it("preserves the scratch as failure evidence, unpoisons the bundle, and retries clean", async () => {
      const root = mkdtempSync(join(dir, "fixture-"));
      writeFileSync(join(root, "index.html"), FIXTURE_HTML);
      const failDef = join(dir, "fail-def.json");
      writeFileSync(failDef, defJson("cli-fail", "text-that-never-appears"));
      const passDef = join(dir, "pass-def.json");
      writeFileSync(passDef, defJson("cli-pass", "hello-fixture"));
      const bundleDir = join(dir, "walkthrough-bundle");

      const server = await serveFixture(root);
      let scratch: string | undefined;
      try {
        const first = capture();
        const code = await runVideoCli(
          [
            "walkthrough",
            "--def",
            failDef,
            "--bundle",
            bundleDir,
            "--base-url",
            server.baseUrl,
          ],
          first.io,
        );
        expect(code).toBe(1);
        const stderr = first.err.join("\n");
        expect(stderr).toMatch(/WALKTHROUGH_ASSERTION_FAILED/);
        expect(stderr).toMatch(/removed unfinalized bundle dir/);

        // The failed run printed its preserved scratch path, and the scratch
        // really holds the diagnosable recording of the failed walkthrough.
        const preserved = first.err.find((line) =>
          line.startsWith("walkthrough scratch preserved for diagnosis: "),
        );
        expect(preserved).toBeDefined();
        scratch = (preserved as string).slice(
          "walkthrough scratch preserved for diagnosis: ".length,
        );
        expect(existsSync(scratch)).toBe(true);
        const recordings = readdirSync(join(scratch, "cli-fail", ".video"));
        expect(recordings.some((name) => /\.(webm|mp4|mov)$/i.test(name))).toBe(
          true,
        );

        // The unfinalized bundle dir is gone, so the retry into the SAME
        // --bundle path succeeds instead of dying with BUNDLE_DIR_EXISTS.
        expect(existsSync(bundleDir)).toBe(false);
        const second = capture();
        const retryCode = await runVideoCli(
          [
            "walkthrough",
            "--def",
            passDef,
            "--bundle",
            bundleDir,
            "--base-url",
            server.baseUrl,
          ],
          second.io,
        );
        expect(retryCode).toBe(0);
        expect(second.out.join("\n")).toMatch(/walkthroughs ran: 1/);
        expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);
      } finally {
        await server.stop();
        if (scratch !== undefined) {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    }, 180_000);
  },
);
