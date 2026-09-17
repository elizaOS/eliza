/** Exercises fused iOS cache admission against real temporary header, archive and metadata files. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fusedSliceCacheMatches,
  recordFusedSliceProvenance,
} from "./ios-fused-slice-cache.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-ios-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outDir = path.join(root, "slice");
  fs.mkdirSync(path.join(outDir, "include"), { recursive: true });
  const sourceHeader = path.join(root, "source-ffi.h");
  const header = path.join(outDir, "include", "eliza-inference-ffi.h");
  fs.writeFileSync(
    sourceHeader,
    "typedef struct EliInferenceContext EliInferenceContext;\n",
  );
  fs.copyFileSync(sourceHeader, header);
  const archive = path.join(outDir, "libelizainference.a");
  fs.writeFileSync(
    archive,
    "test archive bytes representing the recorded build",
  );
  const classifier = path.join(outDir, "libeliza_voice_classifiers.a");
  fs.writeFileSync(classifier, "classifier dependency fixture bytes");
  const options = {
    outDir,
    sourceHeader,
    sourceClean: true,
    sourceRevision: "1891089dbed568cec30b5b9591cba9b85553e3e9",
    target: "ios-arm64-metal-fused",
  };
  const metadata = {
    target: options.target,
    archives: [path.basename(archive), path.basename(classifier)],
    fusedProvenance: recordFusedSliceProvenance({
      ...options,
      archives: [archive, classifier],
    }),
  };
  const writeMetadata = () =>
    fs.writeFileSync(
      path.join(outDir, "CAPABILITIES.json"),
      JSON.stringify(metadata),
    );
  writeMetadata();
  return {
    ...options,
    options,
    metadata,
    writeMetadata,
    archive,
    classifier,
    header,
  };
}

test("admits an unchanged source/header/archive and rejects older metadata without provenance", (t) => {
  const f = fixture(t);
  assert.equal(fusedSliceCacheMatches(f.options), true);
  delete f.metadata.fusedProvenance;
  f.writeMetadata();
  assert.equal(fusedSliceCacheMatches(f.options), false);
});

test("rejects a missing installed FFI header without repairing an unknown archive", (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.header);
  assert.equal(fusedSliceCacheMatches(f.options), false);
  assert.equal(fs.existsSync(f.header), false);
});

test("rejects replaced header bytes on either side of the source/archive boundary", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.sourceHeader, "a changed API declaration");
  assert.equal(fusedSliceCacheMatches(f.options), false);
  fs.copyFileSync(f.sourceHeader, f.header);
  assert.equal(fusedSliceCacheMatches(f.options), false);
});

test("rejects modified or missing native archives", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.archive, "replacement");
  assert.equal(fusedSliceCacheMatches(f.options), false);
  fs.unlinkSync(f.archive);
  assert.equal(fusedSliceCacheMatches(f.options), false);
});

test("rejects a different native revision, dirty source and wrong platform", (t) => {
  const f = fixture(t);
  assert.equal(
    fusedSliceCacheMatches({ ...f.options, sourceRevision: "a".repeat(40) }),
    false,
  );
  assert.equal(
    fusedSliceCacheMatches({ ...f.options, sourceClean: false }),
    false,
  );
  assert.equal(
    fusedSliceCacheMatches({
      ...f.options,
      target: "ios-arm64-simulator-metal-fused",
    }),
    false,
  );
});

test("does not certify a mismatched source and staged header", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.header, "unrelated header");
  assert.throws(
    () => recordFusedSliceProvenance({ ...f.options, archives: [f.archive] }),
    /differs/,
  );
});

test("rejects a self-consistent cache that omitted a required static dependency", (t) => {
  const f = fixture(t);
  f.metadata.archives = [path.basename(f.archive)];
  delete f.metadata.fusedProvenance.archives[path.basename(f.classifier)];
  f.writeMetadata();
  assert.equal(fusedSliceCacheMatches(f.options), false);
  assert.throws(
    () => recordFusedSliceProvenance({ ...f.options, archives: [f.archive] }),
    /voice-classifier dependency/,
  );
});
