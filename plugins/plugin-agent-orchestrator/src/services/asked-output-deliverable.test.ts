/** Unit tests for extractAskedOutputDeliverable — the verbatim relay of a
 *  short plain child response when the user's ask requested output/results.
 *  Deterministic, no runtime; oversized paths hit the REAL durable content
 *  store via a temp trajectory dir. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractAskedOutputDeliverable } from "./sub-agent-router.js";

let trajectoryDir: string;
let savedTrajectoryEnv: string | undefined;

beforeEach(() => {
  trajectoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "asked-output-"));
  savedTrajectoryEnv = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
});

afterEach(() => {
  if (savedTrajectoryEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedTrajectoryEnv;
  fs.rmSync(trajectoryDir, { recursive: true, force: true });
});

describe("extractAskedOutputDeliverable", () => {
  it("relays a short plain response for an output ask", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "Tonight's dinner idea is: Homemade Pizza" },
        "run the dinner picker script and show me the output",
      ),
    ).toBe("Tonight's dinner idea is: Homemade Pizza");
  });

  it("returns undefined when the ask does not request output", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "done, the page is live" },
        "make me a lil recipe box page",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an empty response", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "   " },
        "run it and print the result",
      ),
    ).toBeUndefined();
  });

  it("treats a run-it-again ask as an output ask", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "Fun fact: Venus rotates backwards." },
        "nice, run it again i want another fact",
      ),
    ).toBe("Fun fact: Venus rotates backwards.");
  });

  it("matches the what-is-the-output phrasing", () => {
    expect(
      extractAskedOutputDeliverable(
        { finalText: "42" },
        "what's the output of the script?",
      ),
    ).toBe("42");
  });

  it("projects an oversized response through the durable store when no sessionId exists", () => {
    const out = extractAskedOutputDeliverable(
      { response: "x".repeat(65_536) },
      "run it and show me the output",
    );
    expect(out).toBeDefined();
    expect(out).toContain("GET /api/orchestrator/content/");
    expect(out?.length).toBeLessThanOrEqual(2048);
  });

  it("references the session transcript for an oversized response with a sessionId", () => {
    const out = extractAskedOutputDeliverable(
      { response: "x".repeat(65_536) },
      "run it and show me the output",
      "session-123",
    );
    expect(out).toBeDefined();
    expect(out).toContain("acpx-session-output:session-123");
    expect(out?.length).toBeLessThanOrEqual(2048);
  });
});

import { lastProofBlockOutput } from "./sub-agent-router.js";

describe("lastProofBlockOutput", () => {
  it("pulls the stdout of the last $-command fence", () => {
    const resp = [
      "- [x] the script exists — proof:",
      "```bash",
      "$ ls /w",
      "space_facts.py",
      "```",
      "```bash",
      "$ python3 /w/space_facts.py",
      "The sun makes up 99.86% of the mass in our solar system.",
      "```",
    ].join("\n");
    expect(lastProofBlockOutput(resp)).toBe(
      "The sun makes up 99.86% of the mass in our solar system.",
    );
  });

  it("skips child-elided blocks (the '...' is the child's own loss, not ours)", () => {
    expect(lastProofBlockOutput("```bash\n$ ls\n...\n```")).toBeUndefined();
  });

  it("projects an oversized proof output instead of dropping it", () => {
    const out = lastProofBlockOutput(
      `\`\`\`bash\n$ run\n${"x".repeat(500)}\n\`\`\``,
    );
    expect(out).toBeDefined();
    expect(out).toContain("GET /api/orchestrator/content/");
    expect(out?.length).toBeLessThanOrEqual(400);
  });

  it("ignores fences without command lines", () => {
    expect(lastProofBlockOutput("```\njust code\n```")).toBeUndefined();
  });
});
