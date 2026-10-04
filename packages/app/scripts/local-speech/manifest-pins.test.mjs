import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const MANIFESTS = [
  "download-manifest.json",
  "reference-manifest.json",
  "sherpa-no-espeak-manifest.json",
  "onnxruntime-provenance.json",
];
const FLOATING_REFS = new Set(["main", "master", "HEAD", "develop", "latest"]);

function urlsIn(value) {
  if (typeof value === "string")
    return /^https?:\/\//.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(urlsIn);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(urlsIn);
  return [];
}

test("every local-speech download is pinned to a commit, tag or release", () => {
  const urls = MANIFESTS.flatMap((name) =>
    urlsIn(JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"))),
  );
  assert.ok(urls.length > 0);
  for (const url of urls) {
    const path = new URL(url).pathname;
    const segments = path.split("/");
    // A branch name moves with upstream edits and breaks the sha256 check.
    assert.ok(
      !segments.some((segment) => FLOATING_REFS.has(segment)),
      `${url} follows a moving branch`,
    );
    assert.ok(
      path.includes("/releases/download/") ||
        segments.some(
          (segment) =>
            /^[0-9a-f]{40}$/.test(segment) || /^v?\d+(?:\.\d+)+/.test(segment),
        ),
      `${url} names no commit, version tag or release`,
    );
  }
});
