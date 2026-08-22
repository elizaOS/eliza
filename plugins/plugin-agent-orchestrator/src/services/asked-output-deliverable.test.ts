/** Unit tests for extractAskedOutputDeliverable — the verbatim relay of the
 *  child's plain response when the user's ask requested output/results.
 *  Deterministic, no runtime. COMPLETENESS contract (maintainer close of
 *  #24549-#24553): the asked-for output is model-facing relay text and is
 *  returned COMPLETE whatever its size — no bounded view, no continuation
 *  marker standing in for omitted bytes. */
import { describe, expect, it } from "vitest";
import { extractAskedOutputDeliverable } from "./sub-agent-router.js";

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

  it("relays an oversized response COMPLETE (no bounded view, no marker)", () => {
    const body = "x".repeat(65_536);
    const out = extractAskedOutputDeliverable(
      { response: body },
      "run it and show me the output",
    );
    // COMPLETENESS regression for the retired projection/bounded-view site:
    // the user asked for THE OUTPUT — every byte of it arrives.
    expect(out).toBe(body);
    expect(out).not.toContain("GET /api/orchestrator/content/");
    expect(out).not.toContain("acpx-session-output:");
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

  it("relays an oversized proof output COMPLETE (no projection marker)", () => {
    const body = "x".repeat(50_000);
    const out = lastProofBlockOutput(`\`\`\`bash\n$ run\n${body}\n\`\`\``);
    // COMPLETENESS regression for the retired 400-byte projection site.
    expect(out).toBe(body);
    expect(out).not.toContain("GET /api/orchestrator/content/");
  });

  it("ignores fences without command lines", () => {
    expect(lastProofBlockOutput("```\njust code\n```")).toBeUndefined();
  });
});
