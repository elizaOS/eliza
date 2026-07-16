/**
 * Tests for the pr-evidence uploader's overflow logic: the pure release-
 * selection rule plus the upload/rollover pipeline (uploadAssets, attach,
 * createOverflowReleaseIfAbsent) driven through an injected `gh` runner.
 * Deterministic: no network or real `gh` process is touched.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ASSET_CAPACITY_THRESHOLD,
  attach,
  createOverflowReleaseIfAbsent,
  fetchPrEvidenceReleases,
  isReleaseFullError,
  MAX_ASSETS_PER_RELEASE,
  patchRow,
  prEvidenceReleaseIndex,
  prEvidenceTagForIndex,
  renderRow,
  selectPrEvidenceTarget,
  uploadAssets,
} from "./pr-evidence.mjs";

describe("pr-evidence tag <-> sequence index", () => {
  it("maps the primary tag to index 1 and overflow tags to their number", () => {
    assert.equal(prEvidenceReleaseIndex("pr-evidence"), 1);
    assert.equal(prEvidenceReleaseIndex("pr-evidence-2"), 2);
    assert.equal(prEvidenceReleaseIndex("pr-evidence-10"), 10);
  });

  it("rejects non-family tags and the ambiguous pr-evidence-1", () => {
    assert.equal(prEvidenceReleaseIndex("pr-evidence-1"), null);
    assert.equal(prEvidenceReleaseIndex("pr-evidence-x"), null);
    assert.equal(prEvidenceReleaseIndex("v2.0.0"), null);
    assert.equal(prEvidenceReleaseIndex(""), null);
    assert.equal(prEvidenceReleaseIndex(undefined), null);
  });

  it("round-trips index -> tag", () => {
    assert.equal(prEvidenceTagForIndex(1), "pr-evidence");
    assert.equal(prEvidenceTagForIndex(2), "pr-evidence-2");
    assert.equal(prEvidenceTagForIndex(7), "pr-evidence-7");
    // Defensive: index 0 / negative collapse to the primary tag.
    assert.equal(prEvidenceTagForIndex(0), "pr-evidence");
  });
});

describe("selectPrEvidenceTarget", () => {
  const BELOW = ASSET_CAPACITY_THRESHOLD - 100; // comfortably has room
  const FULL = MAX_ASSETS_PER_RELEASE; // hard cap reached

  it("uploads to the primary release while it has room", () => {
    assert.deepEqual(
      selectPrEvidenceTarget([{ tag: "pr-evidence", count: BELOW }], 3),
      {
        tag: "pr-evidence",
        create: false,
      },
    );
  });

  it("packs into the highest-indexed existing release that has room", () => {
    const releases = [
      { tag: "pr-evidence", count: BELOW },
      { tag: "pr-evidence-2", count: BELOW },
      { tag: "pr-evidence-3", count: BELOW },
    ];
    assert.deepEqual(selectPrEvidenceTarget(releases, 2), {
      tag: "pr-evidence-3",
      create: false,
    });
  });

  it("skips a full primary to the existing overflow release with capacity", () => {
    const releases = [
      { tag: "pr-evidence", count: FULL },
      { tag: "pr-evidence-2", count: BELOW },
    ];
    assert.deepEqual(selectPrEvidenceTarget(releases, 4), {
      tag: "pr-evidence-2",
      create: false,
    });
  });

  it("creates pr-evidence-2 when only the full primary exists", () => {
    assert.deepEqual(
      selectPrEvidenceTarget([{ tag: "pr-evidence", count: FULL }], 1),
      {
        tag: "pr-evidence-2",
        create: true,
      },
    );
  });

  it("creates the next tag when every existing release is full", () => {
    const releases = [
      { tag: "pr-evidence", count: FULL },
      { tag: "pr-evidence-2", count: FULL },
    ];
    assert.deepEqual(selectPrEvidenceTarget(releases, 1), {
      tag: "pr-evidence-3",
      create: true,
    });
  });

  it("treats a release at/over the headroom threshold as having no room", () => {
    const releases = [{ tag: "pr-evidence", count: ASSET_CAPACITY_THRESHOLD }];
    assert.deepEqual(selectPrEvidenceTarget(releases, 1), {
      tag: "pr-evidence-2",
      create: true,
    });
  });

  it("rolls over when a large batch would exceed the hard cap even below threshold", () => {
    // Under the soft threshold, but the batch itself would push past 1000.
    const count = ASSET_CAPACITY_THRESHOLD - 5; // < threshold, so threshold alone allows it
    const neededSlots = 20; // count + neededSlots > MAX_ASSETS_PER_RELEASE
    assert.ok(count < ASSET_CAPACITY_THRESHOLD);
    assert.ok(count + neededSlots > MAX_ASSETS_PER_RELEASE);
    assert.deepEqual(
      selectPrEvidenceTarget([{ tag: "pr-evidence", count }], neededSlots),
      { tag: "pr-evidence-2", create: true },
    );
  });

  it("ignores non-family releases entirely", () => {
    const releases = [
      { tag: "v2.0.0-beta.1", count: 5 },
      { tag: "pr-evidence", count: BELOW },
    ];
    assert.deepEqual(selectPrEvidenceTarget(releases, 1), {
      tag: "pr-evidence",
      create: false,
    });
  });

  it("creates the primary when no pr-evidence release exists yet", () => {
    assert.deepEqual(selectPrEvidenceTarget([], 1), {
      tag: "pr-evidence",
      create: true,
    });
    assert.deepEqual(selectPrEvidenceTarget([{ tag: "v1.0.0", count: 1 }], 1), {
      tag: "pr-evidence",
      create: true,
    });
  });
});

/**
 * Scripted `gh` stand-in: answers `api` calls with canned NDJSON release
 * listings, records every `release create`/`release upload`, and throws the
 * queued error (a 422, a race, …) on the matching upload attempt.
 */
function fakeGh({ releases = [], failUploads = [], createError = null } = {}) {
  const calls = [];
  let uploadAttempt = 0;
  const run = (args) => {
    calls.push(args);
    if (args[0] === "api") {
      return releases
        .map((release) =>
          JSON.stringify({ tag: release.tag, assets: release.assets ?? [] }),
        )
        .join("\n");
    }
    if (args[0] === "release" && args[1] === "create") {
      if (createError) throw createError;
      return "";
    }
    if (args[0] === "release" && args[1] === "upload") {
      const failure = failUploads[uploadAttempt];
      uploadAttempt += 1;
      if (failure) throw failure;
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { run, calls };
}

function http422FileCount() {
  const err = new Error("gh: release upload failed");
  err.stderr =
    "HTTP 422: Validation Failed — file_count exceeds the maximum number of files per release";
  return err;
}

/** Runs `fn` with process.exit stubbed to throw, so `fail()` paths are assertable. */
function withExitTrap(fn) {
  const realExit = process.exit;
  process.exit = (code) => {
    const err = new Error(`process.exit(${code})`);
    err.exitCode = code;
    throw err;
  };
  try {
    return fn();
  } finally {
    process.exit = realExit;
  }
}

function stagedFile(name, contents = "evidence-bytes") {
  const dir = mkdtempSync(join(tmpdir(), "pr-evidence-test-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("isReleaseFullError", () => {
  it("matches the over-cap 422 but not a name-collision 422", () => {
    assert.ok(isReleaseFullError(http422FileCount().stderr));
    assert.ok(
      !isReleaseFullError("HTTP 422: Validation Failed — already_exists"),
    );
    assert.ok(!isReleaseFullError("file_count exceeded")); // no HTTP 422 token
  });
});

describe("uploadAssets (injected gh runner)", () => {
  const staged = () => new Map([["77-shot.png", stagedFile("77-shot.png")]]);

  it("pre-selects a release below the 990 headroom threshold and uploads once", () => {
    const { run, calls } = fakeGh();
    const urls = uploadAssets(
      staged(),
      [
        {
          tag: "pr-evidence",
          assets: Array(ASSET_CAPACITY_THRESHOLD).fill({}),
        },
        { tag: "pr-evidence-2", assets: Array(10).fill({}) },
      ],
      run,
    );
    const uploads = calls.filter(
      (c) => c[0] === "release" && c[1] === "upload",
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0][2], "pr-evidence-2");
    assert.equal(
      urls.get("77-shot.png"),
      "https://github.com/elizaOS/eliza/releases/download/pr-evidence-2/77-shot.png",
    );
  });

  it("creates the next overflow release when every observed release is at capacity", () => {
    const { run, calls } = fakeGh();
    const urls = uploadAssets(
      staged(),
      [{ tag: "pr-evidence", assets: Array(MAX_ASSETS_PER_RELEASE).fill({}) }],
      run,
    );
    const create = calls.find((c) => c[0] === "release" && c[1] === "create");
    assert.equal(create?.[2], "pr-evidence-2");
    assert.match(
      urls.get("77-shot.png"),
      /\/releases\/download\/pr-evidence-2\/77-shot\.png$/,
    );
  });

  it("rolls over on a 422 file_count race and retries on the next release", () => {
    const { run, calls } = fakeGh({ failUploads: [http422FileCount()] });
    const urls = uploadAssets(
      staged(),
      [{ tag: "pr-evidence", assets: [] }],
      run,
    );
    const uploads = calls.filter(
      (c) => c[0] === "release" && c[1] === "upload",
    );
    assert.deepEqual(
      uploads.map((c) => c[2]),
      ["pr-evidence", "pr-evidence-2"],
    );
    assert.match(urls.get("77-shot.png"), /pr-evidence-2/);
  });

  it("rethrows a non-capacity upload error instead of rolling over", () => {
    const err = new Error("boom");
    err.stderr =
      "HTTP 422: Validation Failed — already_exists (name collision)";
    const { run } = fakeGh({ failUploads: [err] });
    assert.throws(
      () => uploadAssets(staged(), [{ tag: "pr-evidence", assets: [] }], run),
      /boom/,
    );
  });

  it("gives up after a bounded number of re-selections when everything 422s", () => {
    const attempts = 1 + 4; // releases.length + 4
    const { run, calls } = fakeGh({
      failUploads: Array(attempts + 5)
        .fill(null)
        .map(() => http422FileCount()),
    });
    withExitTrap(() => {
      assert.throws(
        () => uploadAssets(staged(), [{ tag: "pr-evidence", assets: [] }], run),
        /process\.exit\(1\)/,
      );
    });
    const uploads = calls.filter(
      (c) => c[0] === "release" && c[1] === "upload",
    );
    assert.equal(uploads.length, attempts);
  });
});

describe("createOverflowReleaseIfAbsent", () => {
  it("tolerates a concurrent lane that created the release first", () => {
    const raced = new Error("gh: release create failed");
    raced.stderr = "HTTP 422: Validation Failed — tag_name already exists";
    const { run } = fakeGh({ createError: raced });
    assert.doesNotThrow(() =>
      createOverflowReleaseIfAbsent("pr-evidence-2", run),
    );
  });

  it("rethrows a create failure that is not an already-exists race", () => {
    const denied = new Error("HTTP 403: forbidden");
    const { run } = fakeGh({ createError: denied });
    assert.throws(
      () => createOverflowReleaseIfAbsent("pr-evidence-3", run),
      /403/,
    );
  });
});

describe("attach (injected gh runner)", () => {
  it("reuses an asset already on any family release without re-uploading", () => {
    const existingUrl =
      "https://github.com/elizaOS/eliza/releases/download/pr-evidence/123-shot.png";
    const { run, calls } = fakeGh({
      releases: [
        {
          tag: "pr-evidence",
          assets: [{ name: "123-shot.png", url: existingUrl }],
        },
      ],
    });
    const urls = attach(123, [stagedFile("shot.png")], run);
    assert.equal(urls.get("123-shot.png"), existingUrl);
    assert.ok(!calls.some((c) => c[0] === "release" && c[1] === "upload"));
  });

  it("uploads a genuinely new asset under the <pr>- prefix", () => {
    const { run, calls } = fakeGh({
      releases: [{ tag: "pr-evidence", assets: [] }],
    });
    const urls = attach(124, [stagedFile("walk.mp4")], run);
    assert.equal(
      urls.get("124-walk.mp4"),
      "https://github.com/elizaOS/eliza/releases/download/pr-evidence/124-walk.mp4",
    );
    const upload = calls.find((c) => c[0] === "release" && c[1] === "upload");
    assert.equal(upload?.[2], "pr-evidence");
  });

  it("refuses an empty (0-byte) artifact", () => {
    const { run } = fakeGh({ releases: [{ tag: "pr-evidence", assets: [] }] });
    withExitTrap(() => {
      assert.throws(
        () => attach(125, [stagedFile("empty.log", "")], run),
        /process\.exit\(1\)/,
      );
    });
  });

  it("parses the paginated NDJSON release listing", () => {
    const { run } = fakeGh({
      releases: [
        { tag: "pr-evidence", assets: [{ name: "a", url: "u" }] },
        { tag: "pr-evidence-2", assets: [] },
      ],
    });
    const releases = fetchPrEvidenceReleases(run);
    assert.deepEqual(
      releases.map((release) => release.tag),
      ["pr-evidence", "pr-evidence-2"],
    );
    assert.equal(releases[0].assets[0].name, "a");
  });
});

describe("row rendering and body patching", () => {
  it("renders media URLs, file links, and N/A rows distinctly", () => {
    assert.equal(
      renderRow("after-screenshots", "https://x.test/a.png"),
      "- [x] ![after-screenshots](https://x.test/a.png)",
    );
    assert.equal(
      renderRow("walkthrough-video", "https://x.test/w.mp4"),
      "- [x] https://x.test/w.mp4",
    );
    assert.equal(
      renderRow("backend-logs", "https://x.test/b.log"),
      "- [x] [b.log](https://x.test/b.log)",
    );
    assert.equal(
      renderRow("frontend-logs", "N/A - no frontend change"),
      "- [ ] N/A - no frontend change",
    );
  });

  it("replaces the block after an existing marker and appends when absent", () => {
    const body =
      "intro\n\n<!-- evidence-row:backend-logs -->\n- [ ] old row\n\n## next";
    const patched = patchRow(body, "backend-logs", "- [x] new row");
    assert.match(
      patched,
      /<!-- evidence-row:backend-logs -->\n- \[x\] new row/,
    );
    assert.ok(!patched.includes("old row"));
    const appended = patchRow("no markers here", "llm-trajectory", "- [x] t");
    assert.match(
      appended,
      /<!-- evidence-row:llm-trajectory -->\n- \[x\] t\n$/,
    );
  });
});
