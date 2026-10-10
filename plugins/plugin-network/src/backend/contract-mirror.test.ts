/**
 * The wire contract is mirrored byte-for-byte in eliza-research/thenetwork
 * (packages/core/src/svc/{contract,svc-auth}.ts). The service and the Eliza side must sign and parse
 * the same bytes, so neither copy may change alone.
 *
 * This test pins the SHA-256 of both files here. When it fails you changed the wire contract:
 *   1. Copy both files unchanged into eliza-research/thenetwork packages/core/src/svc/ and land that
 *      change together with this one (same contract, both repos).
 *   2. Run `bun run check:mirror` in plugins/plugin-network (needs `gh` signed in with access to
 *      eliza-research/thenetwork); it compares this package's files with thenetwork's develop copy.
 *   3. Update the hashes below to the values `shasum -a 256 src/backend/{contract,svc-auth}.ts` prints.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIRRORED_CONTRACT_SHA256: Record<string, string> = {
  "contract.ts":
    "8c7e68ff489d33919939890d019787ddf07d64070f867c22d9fe2e3dd88d4b5d",
  "svc-auth.ts":
    "80c561af25581926e6317837f91e92063e4655e5cd9a687597ce4ea8ce297c70",
};

const sha256 = (file: string) =>
  createHash("sha256")
    .update(readFileSync(new URL(`./${file}`, import.meta.url)))
    .digest("hex");

describe("Network wire contract mirror", () => {
  for (const [file, pinned] of Object.entries(MIRRORED_CONTRACT_SHA256)) {
    it(`${file} matches its pinned hash (update thenetwork's mirror with it)`, () => {
      assert.equal(
        sha256(file),
        pinned,
        `${file} changed. Mirror it to eliza-research/thenetwork packages/core/src/svc/${file}, then update the pin (see the comment at the top of contract-mirror.test.ts).`,
      );
    });
  }
});
