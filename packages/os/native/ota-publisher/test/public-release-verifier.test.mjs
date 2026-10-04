import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPublicReleaseVerifier } from "../public-release-verifier.mjs";
import { createReleaseContract } from "../release-contract.mjs";

const { validateRelease } = createReleaseContract({
  product: "example-app",
  packageId: "org.example.app",
  cohortNamespace: "example-ota-v1",
});
const { verifyPublicRelease, readPublicGitHubJSON } =
  createPublicReleaseVerifier({
    validateRelease,
    userAgent: "example-release-verifier",
  });

import { fixture } from "./release-fixture.mjs";

function setup() {
  const d = fixture().release,
    base = `/repos/${d.source.repository}`,
    release = {
      id: 10,
      draft: false,
      immutable: true,
      tag_name: d.source.tag,
      published_at: "2026-10-02T00:00:00Z",
      target_commitish: "untrusted-branch",
      prerelease: true,
    };
  const files = new Map([
    [base, { private: false, full_name: d.source.repository }],
    [`${base}/releases/tags/${d.source.tag}`, release],
    [`${base}/releases/10`, structuredClone(release)],
    [
      `${base}/git/ref/tags/${d.source.tag}`,
      {
        ref: `refs/tags/${d.source.tag}`,
        object: { type: "commit", sha: d.source.commit },
      },
    ],
    [
      `${base}/releases/10/assets?per_page=100&page=1`,
      ["candidate", "recovery"].map((n, i) => ({
        id: i + 1,
        name: new URL(d[n].url).pathname.split("/").at(-1),
        state: "uploaded",
        browser_download_url: d[n].url,
        size: d[n].length,
        digest: `sha256:${d[n].sha256}`,
      })),
    ],
  ]);
  const calls = [];
  const readJSON = async (endpoint) => {
    calls.push(endpoint);
    assert.ok(files.has(endpoint), endpoint);
    return structuredClone(files.get(endpoint));
  };
  return { d, base, files, calls, readJSON };
}
test("publication barrier verifies public immutable assets and actual tag commit without trusting prerelease labels", async () => {
  const s = setup(),
    r = await verifyPublicRelease(s.d, {
      hosts: ["github.com"],
      readJSON: s.readJSON,
    });
  assert.equal(r.publicReleaseVerified, true);
  assert.equal(r.artifactBytesVerified, false);
  assert.equal(r.requests, 5);
  assert.equal(r.commit, s.d.source.commit);
  assert.ok(!s.calls.some((p) => p.includes("/latest")));
});
test("publication barrier refuses absent, mutable, incomplete and mismatched publication", async () => {
  const cases = [
    (s) => (s.files.get(s.base).private = true),
    (s) => (s.files.get(s.base).full_name = "other/repo"),
    (s) =>
      (s.files.get(`${s.base}/releases/tags/${s.d.source.tag}`).draft = true),
    (s) =>
      (s.files.get(`${s.base}/releases/tags/${s.d.source.tag}`).immutable =
        false),
    (s) =>
      delete s.files.get(`${s.base}/releases/tags/${s.d.source.tag}`).immutable,
    (s) =>
      (s.files.get(`${s.base}/git/ref/tags/${s.d.source.tag}`).object.sha =
        "f".repeat(40)),
    (s) => (s.files.get(`${s.base}/releases/10`).immutable = false),
    (s) => (s.files.get(`${s.base}/releases/10`).id = 11),
    (s) =>
      s.files.get(`${s.base}/releases/10/assets?per_page=100&page=1`).pop(),
    (s) =>
      (s.files.get(
        `${s.base}/releases/10/assets?per_page=100&page=1`,
      )[0].state = "starter"),
    (s) =>
      (s.files.get(
        `${s.base}/releases/10/assets?per_page=100&page=1`,
      )[0].digest = null),
    (s) =>
      s.files.get(`${s.base}/releases/10/assets?per_page=100&page=1`)[0].size++,
    (s) =>
      (s.files.get(
        `${s.base}/releases/10/assets?per_page=100&page=1`,
      )[0].browser_download_url = "https://other.example/file.apk"),
    (s) => {
      const a = s.files.get(`${s.base}/releases/10/assets?per_page=100&page=1`);
      a.push(a[0]);
    },
  ];
  for (const change of cases) {
    const s = setup();
    change(s);
    await assert.rejects(
      verifyPublicRelease(s.d, { hosts: ["github.com"], readJSON: s.readJSON }),
      /OTA publication:/,
    );
  }
});
test("publication barrier follows bounded annotated tags and paginates asset evidence", async () => {
  const s = setup(),
    tag = "e".repeat(40);
  s.files.get(`${s.base}/git/ref/tags/${s.d.source.tag}`).object = {
    type: "tag",
    sha: tag,
    url: "https://untrusted.invalid/ignored",
  };
  s.files.set(`${s.base}/git/tags/${tag}`, {
    sha: tag,
    object: { type: "commit", sha: s.d.source.commit },
  });
  const assets = s.files.get(
    `${s.base}/releases/10/assets?per_page=100&page=1`,
  );
  s.files.set(
    `${s.base}/releases/10/assets?per_page=100&page=1`,
    Array.from({ length: 100 }, (_, i) => ({
      id: 100 + i,
      name: `notes-${i}`,
    })),
  );
  s.files.set(`${s.base}/releases/10/assets?per_page=100&page=2`, assets);
  assert.equal(
    (
      await verifyPublicRelease(s.d, {
        hosts: ["github.com"],
        readJSON: s.readJSON,
      })
    ).requests,
    7,
  );
  s.files.get(`${s.base}/git/tags/${tag}`).object = { type: "tag", sha: tag };
  await assert.rejects(
    verifyPublicRelease(s.d, { hosts: ["github.com"], readJSON: s.readJSON }),
    /cyclic/,
  );
});
test("publication barrier does not swallow network or rate limit failures", async () => {
  const s = setup();
  await assert.rejects(
    verifyPublicRelease(s.d, {
      hosts: ["github.com"],
      readJSON: async () => {
        throw Error("429 fixture");
      },
    }),
    /429 fixture/,
  );
});

test("anonymous transport rejects arbitrary origins and path traversal before networking", () => {
  for (const endpoint of [
    "https://example.com/repos/a/b",
    "/repos/a/b/../../x",
    "/repos/a/b#fragment",
    "/repos/a/b?token=secret",
  ])
    assert.throws(() => readPublicGitHubJSON(endpoint), /OTA publication:/);
});

test("public verifier requires host policy before any reads", async () => {
  assert.throws(() => createPublicReleaseVerifier());
  assert.throws(() =>
    createPublicReleaseVerifier({
      validateRelease,
      userAgent: "bad\r\nheader",
    }),
  );
  let calls = 0;
  const verifier = createPublicReleaseVerifier({
    userAgent: "example",
    validateRelease() {
      throw Error("rejected host identity");
    },
  });
  await assert.rejects(
    verifier.verifyPublicRelease(fixture().release, {
      hosts: ["github.com"],
      readJSON: async () => {
        calls++;
      },
    }),
    /rejected host identity/,
  );
  assert.equal(calls, 0);
});

test("file verification rejects nonregular, oversized and ambiguous descriptors before host policy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-release-inputs-"));
  let calls = 0;
  const verifier = createPublicReleaseVerifier({
    userAgent: "example",
    validateRelease() {
      calls++;
      throw Error("host policy stop");
    },
  });
  try {
    const large = path.join(dir, "large");
    fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));
    const link = path.join(dir, "link");
    fs.symlinkSync(large, link);
    const ambiguous = path.join(dir, "duplicate.json");
    fs.writeFileSync(ambiguous, '{"a":1,"a":2}');
    for (const file of [dir, large, link, ambiguous])
      await assert.rejects(
        verifier.verifyPublicReleaseFile(file, { hosts: ["github.com"] }),
      );
    assert.equal(calls, 0);
    const valid = path.join(dir, "valid.json");
    fs.writeFileSync(valid, JSON.stringify(fixture().release));
    await assert.rejects(
      verifier.verifyPublicReleaseFile(valid, { hosts: ["github.com"] }),
      /host policy stop/,
    );
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
