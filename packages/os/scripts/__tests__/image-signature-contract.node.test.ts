import assert from "node:assert/strict";
import test from "node:test";
import { artifactSignaturePayload } from "../../contracts/index.ts";

test("artifact signature payload retains the released byte contract", () => {
  const fields = {
    url: "https://example.test/image.raw.zst",
    architecture: "arm64",
    sequence: 17,
    compressedSize: 23,
    expandedSize: 42,
    sha256Compressed: "a".repeat(64),
    sha256Expanded: "b".repeat(64),
  };
  assert.deepEqual(
    Buffer.from(artifactSignaturePayload(fields)),
    Buffer.from(
      `elizaOS-artifact-v1\nhttps://example.test/image.raw.zst\narm64\n17\n23\n42\n${"a".repeat(64)}\n${"b".repeat(64)}\n`,
      "utf8",
    ),
  );
});
