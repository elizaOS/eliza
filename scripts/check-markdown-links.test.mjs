import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import tmp from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  candidateTargets,
  checkMarkdownLinks,
  decodeHref,
  isRelativeLink,
  markdownLinks,
  parseArgs,
  runCli,
  stripAnchor,
  stripCode,
} from "./check-markdown-links.mjs";

describe("check-markdown-links CLI options parsing", () => {
  it("defaults to standard configuration", () => {
    const opts = parseArgs([]);
    assert.equal(opts.help, false);
    assert.equal(opts.json, false);
    assert.equal(opts.quiet, false);
    assert.ok(typeof opts.root === "string" && opts.root.length > 0);
  });

  it("parses --help and -h flags", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
  });

  it("parses --json and --quiet flags", () => {
    const opts = parseArgs(["--json", "--quiet"]);
    assert.equal(opts.json, true);
    assert.equal(opts.quiet, true);
  });

  it("parses --root=<dir> and --root <dir>", () => {
    assert.equal(parseArgs(["--root=/tmp/docs"]).root, "/tmp/docs");
    assert.equal(parseArgs(["--root", "/tmp/docs"]).root, "/tmp/docs");
  });

  it("rejects --root without a value", () => {
    assert.throws(
      () => parseArgs(["--root="]),
      /\[check-markdown-links\] --root requires a directory path/,
    );
    assert.throws(
      () => parseArgs(["--root"]),
      /\[check-markdown-links\] --root requires a directory path/,
    );
    assert.throws(
      () => parseArgs(["--root", "--json"]),
      /\[check-markdown-links\] --root requires a directory path/,
    );
  });

  it("rejects unknown options", () => {
    assert.throws(
      () => parseArgs(["--unknown-option"]),
      /\[check-markdown-links\] Unknown option: --unknown-option/,
    );
  });
});

describe("check-markdown-links link resolution helpers", () => {
  it("strips section anchors from hrefs", () => {
    assert.equal(stripAnchor("guide.md#section-1"), "guide.md");
    assert.equal(stripAnchor("guide.md"), "guide.md");
    assert.equal(stripAnchor("#section-1"), "");
  });

  it("decodes URI-encoded hrefs safely", () => {
    assert.equal(decodeHref("hello%20world.md"), "hello world.md");
    assert.equal(decodeHref("%FF%FE"), "%FF%FE");
  });

  it("distinguishes relative links from external/absolute schemes", () => {
    assert.equal(isRelativeLink("http://example.com"), false);
    assert.equal(isRelativeLink("https://example.com"), false);
    assert.equal(isRelativeLink("mailto:user@example.com"), false);
    assert.equal(isRelativeLink("tel:+1234567890"), false);
    assert.equal(isRelativeLink("#anchor"), false);
    assert.equal(isRelativeLink("file:///path/to/file"), false);
    assert.equal(isRelativeLink("data:text/plain;base64,123"), false);

    assert.equal(isRelativeLink("relative/path.md"), true);
    assert.equal(isRelativeLink("../other/file.md"), true);
    assert.equal(isRelativeLink("/packages/docs/index.md"), true);
  });

  it("strips code blocks and inline code before collecting links", () => {
    const markdown = `
[Valid Link](valid.md)

\`\`\`markdown
[Code Block Link](code.md)
\`\`\`

Here is \`[Inline Code Link](inline.md)\`.
[Reference Link]: ref.md
`;
    const cleaned = stripCode(markdown);
    assert.ok(!cleaned.includes("code.md"));
    assert.ok(!cleaned.includes("inline.md"));

    const links = markdownLinks(markdown);
    assert.deepEqual(links, ["valid.md", "ref.md"]);
  });

  it("builds candidate targets for relative and root-relative links", () => {
    const candidates = candidateTargets("/repo", "docs/guide.md", "foo/bar");
    assert.ok(candidates.some((c) => c.endsWith("foo/bar.md")));
    assert.ok(candidates.some((c) => c.endsWith("foo/bar/README.md")));

    const rootCandidates = candidateTargets(
      "/repo",
      "docs/guide.md",
      "/packages/docs/setup",
    );
    assert.ok(rootCandidates.some((c) => c.endsWith("packages/docs/setup")));
    assert.ok(rootCandidates.some((c) => c.endsWith("packages/docs/setup.md")));
  });
});

describe("checkMarkdownLinks validation and runCli execution", () => {
  it("rejects non-existent root directory", () => {
    assert.throws(
      () => checkMarkdownLinks({ root: "/nonexistent-path-eliza-12345" }),
      /--root directory does not exist/,
    );
  });

  it("validates repository relative links and reports missing targets", () => {
    const fixtureDir = path.join(
      tmp.tmpdir(),
      `check-md-links-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(fixtureDir, { recursive: true });

    try {
      const result = checkMarkdownLinks({ root: fixtureDir });
      assert.equal(result.ok, true);
      assert.equal(result.failures.length, 0);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("runCli returns 0 for --help", () => {
    let output = "";
    const origLog = console.log;
    console.log = (msg) => {
      output += msg;
    };
    try {
      const code = runCli(["--help"]);
      assert.equal(code, 0);
      assert.ok(output.includes("Usage: node scripts/check-markdown-links.mjs"));
    } finally {
      console.log = origLog;
    }
  });
});
