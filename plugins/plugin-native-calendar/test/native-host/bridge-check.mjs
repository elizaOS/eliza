// Run after compiling the actual shared bridge and host against their real Android APIs.
// This checks JVM dispatch with a controlled provider, not Android/provider acceptance.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["classes", "classpath", "json", "host", "journal", "prefix"].map(
      (name) => [name, { type: "string" }],
    ),
  ),
});
for (const name of [
  "classes",
  "classpath",
  "json",
  "host",
  "journal",
  "prefix",
])
  if (!values[name]) throw new Error(`Missing --${name}`);
const root = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "calendar-bridge-"));
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : entry.name.endsWith(".java")
        ? [join(directory, entry.name)]
        : [],
  );
const binary = (name) =>
  process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
try {
  execFileSync(
    binary("javac"),
    [
      "--release",
      "21",
      "-cp",
      `${values.classes}:${values.classpath}`,
      "-d",
      directory,
      ...files(join(root, "bridge-runtime")),
      join(root, "read-window/android/provider/CalendarContract.java"),
    ],
    { stdio: "pipe", timeout: 60000 },
  );
  const result = execFileSync(
    binary("java"),
    [
      "-cp",
      `${directory}:${values.classes}:${values.json}:${values.classpath}`,
      "ai.eliza.plugins.calendar.CalendarBridgeContract",
      values.host,
      values.journal,
      values.prefix,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  process.stdout.write(result);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
