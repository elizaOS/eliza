// Video CLI argv contract, tool-free (always runs). Drives runVideoCli with a
// captured IO instead of spawning a process: asserts usage on no command,
// unknown-arg / missing-required / bad-enum rejections surface as a structured
// error line + non-zero exit, and the ingest command rejects a bad granularity.
// The happy paths (which launch chromium/ffmpeg) are covered by the driver and
// walkthroughs suites, not here.
import { describe, expect, it } from "vitest";
import { type CliIo, runVideoCli } from "./cli.ts";

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
