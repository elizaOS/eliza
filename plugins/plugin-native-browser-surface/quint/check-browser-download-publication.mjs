import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const relative = (file) => fileURLToPath(new URL(file, import.meta.url));
assert.equal(
  path.resolve(process.argv[2] ?? ""),
  relative("./BrowserDownloadPublication.qnt"),
);
const source = relative(
  "../android/src/main/java/ai/eliza/plugins/browsersurface/",
);
const host = readFileSync(path.join(source, "BrowserDownloads.java"), "utf8");
function between(from, to) {
  const start = host.indexOf(from);
  const end = host.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing download source: ${from}`);
  return host.slice(start, end);
}
const fields = between(
  "  private final Map<Long, Long> received",
  "  private AlertDialog pending",
);
const methods = [
  between(
    "  private static final class Cancelled",
    "  /**\n   * Fetch a signed-in file",
  ),
  between(
    "  private Uri publish(InputStream",
    "  /**\n   * The requesting tab navigated",
  ),
  between("  private void cancelTransfer(", "  /** A private tab closed"),
  between("  private void removeFromList(", "  /** Dismiss only UI"),
  between("  public void destroy()", "  /** Where blob:"),
].join("\n");
const admission = between("    transfers.put(id,", "    work(network,")
  .trim()
  .split("\n")
  .map((line) => `h.${line.trim().replace("(id,", "(ID,")}`)
  .join("\n");
const fixture = readFileSync(
  relative("./BrowserDownloadPublicationProbe.java.in"),
  "utf8",
);
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const output = mkdtempSync(
  path.join(tmpdir(), "browser-download-publication-"),
);
try {
  const probe = path.join(output, "BrowserDownloadPublicationProbe.java");
  writeFileSync(
    probe,
    fixture
      .replace("// PRODUCTION_FIELDS", () => fields)
      .replace("// PRODUCTION_METHODS", () => methods)
      .replace("// PRODUCTION_ADMISSION", () => admission),
  );
  execFileSync(
    java("javac"),
    [
      "-J-Xmx128m",
      "-d",
      output,
      probe,
      ...["BrowserDownloadPolicy", "BrowserWebOrigin"].map((name) =>
        path.join(source, `${name}.java`),
      ),
    ],
    { timeout: 60_000 },
  );
  for (const scenario of [
    "cancel-at-eof",
    "forget-after-final-read",
    "publish-wins",
    "committed-then-throw",
    "destroy-after-eof",
    "copy-failed",
    "update-failed",
    "update-zero",
    "captured",
  ]) {
    execFileSync(
      java("java"),
      [
        "-Xmx128m",
        "-cp",
        output,
        "ai.eliza.plugins.browsersurface.BrowserDownloadPublicationProbe",
        scenario,
      ],
      { timeout: 15_000 },
    );
    process.stdout.write(`${scenario} passed\n`);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
