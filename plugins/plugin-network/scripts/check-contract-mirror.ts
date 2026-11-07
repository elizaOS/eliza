/**
 * Compares src/backend/{contract,svc-auth}.ts with the byte-for-byte mirror in
 * eliza-research/thenetwork (packages/core/src/svc/). Uses the GitHub CLI, so it needs `gh` signed in
 * with read access to that repo. Exit 1 on any difference.
 *
 *   bun run check:mirror            # against thenetwork's default branch
 *   bun run check:mirror -- <ref>   # against a branch, tag or sha
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = "eliza-research/thenetwork";
const FILES = ["contract.ts", "svc-auth.ts"] as const;
const ref = process.argv[2];

let failed = false;
for (const file of FILES) {
  const path = `packages/core/src/svc/${file}`;
  const api = `repos/${REPO}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const r = spawnSync(
    "gh",
    ["api", api, "-H", "Accept: application/vnd.github.raw"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`could not read ${REPO}/${path}: ${r.stderr.trim()}`);
    failed = true;
    continue;
  }
  const local = readFileSync(
    new URL(`../src/backend/${file}`, import.meta.url),
    "utf8",
  );
  if (local === r.stdout) {
    console.log(`ok       ${file}`);
  } else {
    console.error(
      `MISMATCH ${file}: plugins/plugin-network/src/backend/${file} != ${REPO}/${path}`,
    );
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
