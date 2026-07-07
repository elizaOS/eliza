/**
 * Mechanical enforcement for the surface-realm raw-global guards (#13452): fails
 * if any source in packages/ui + packages/app writes a shell-reserved
 * localStorage key (`eliza:`/`elizaos:`/`eliza_`) outside the privileged channel
 * (`shellLocalStorage` / `runAsPrivilegedShell`).
 *
 * The guard Proxy is realm-wide, so a raw reserved-key write throws while a view
 * scope is foreground and the writer's own catch swallows it into silent
 * persistence loss. Per-writer positive tests cannot catch a MISSED writer;
 * this static scan (comment-stripped, per-file symbol resolution with
 * import-following, `storage()`-accessor + param-helper resolution) can, and is
 * the permanent regression guard that keeps the migration a one-time sweep. See
 * `scripts/scan-reserved-storage-writers.mjs` for the resolution rules and its
 * one documented static-analysis limit.
 */

import { describe, expect, it } from "vitest";
// The scanner is a dependency-free node script (fs + regex), imported here so
// the one implementation is both CI-enforced and runnable standalone.
import { findRawReservedStorageWriters } from "../scripts/scan-reserved-storage-writers.mjs";

describe("surface-realm reserved-key writers are routed through the privileged channel (#13452)", () => {
  it("has no raw window.localStorage writer of an eliza:/elizaos:/eliza_ key", () => {
    const violations = findRawReservedStorageWriters();
    const report = violations
      .map((v) => `  ${v.file}:${v.line}  .${v.op}(${v.key})`)
      .join("\n");
    expect(
      violations,
      `Raw reserved-key localStorage writer(s) found — route through ` +
        `shellLocalStorage / runAsPrivilegedShell (surface-realm-channel):\n${report}`,
    ).toHaveLength(0);
  });
});
