import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const model = fileURLToPath(
  new URL("./BrowserSitePermissionPresentation.qnt", import.meta.url),
);
assert.equal(path.resolve(process.argv[2] ?? ""), model);
const source = fileURLToPath(
  new URL(
    "../android/src/main/java/ai/eliza/plugins/browsersurface/",
    import.meta.url,
  ),
);
const host = readFileSync(
  path.join(source, "BrowserTabHostPlugin.java"),
  "utf8",
);
function sourceBetween(startMarker, endMarker) {
  const start = host.indexOf(startMarker);
  const end = host.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Missing host source: ${startMarker}`);
  return host.slice(start, end);
}
const selection = sourceBetween(
  " private long presentationRevision;",
  " private boolean paused;",
);
assert.equal(
  host.match(/\bpresentedId\s*=(?!=)/g)?.length,
  1,
  "Only the selected-presentation updater writes presentedId",
);
const permission = sourceBetween(
  " private void sitePermission(",
  " private void mediaPermission(",
);
const fixture = readFileSync(
  new URL("./BrowserPermissionPresentationProbe.java.in", import.meta.url),
  "utf8",
);
const javaBin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const output = mkdtempSync(path.join(tmpdir(), "browser-site-permission-"));
try {
  const probe = path.join(output, "BrowserPermissionPresentationProbe.java");
  writeFileSync(
    probe,
    fixture
      .replace("// PRODUCTION_SELECTION", () => selection)
      .replace("// PRODUCTION_PERMISSION", () => permission),
  );
  execFileSync(
    javaBin("javac"),
    [
      "-J-Xmx128m",
      "-d",
      output,
      probe,
      ...[
        "BrowserSitePrompt",
        "BrowserSitePermissions",
        "BrowserWebOrigin",
      ].map((name) => path.join(source, `${name}.java`)),
    ],
    { timeout: 60_000 },
  );
  for (const scenario of [
    "same-presentation-os-pause",
    "tab-switch",
    "tab-round-trip",
    "hide-and-reopen",
    "navigate",
    "origin-change",
    "same-id-replaced",
    "unselected-denial-is-quiet",
    "notice-retires-presentation",
    "fresh-review",
    "dismissed-dialog-cannot-write",
    "stale-review-cannot-write",
  ]) {
    execFileSync(
      javaBin("java"),
      [
        "-Xmx128m",
        "-cp",
        output,
        "BrowserPermissionPresentationProbe",
        scenario,
      ],
      { timeout: 15_000 },
    );
    process.stdout.write(`${scenario} passed\n`);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
