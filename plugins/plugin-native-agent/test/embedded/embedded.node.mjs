import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const source = (name) =>
  path.join(
    root,
    "android/src/main/java/ai/eliza/plugins/agent",
    `${name}.java`,
  );
const jsonJar = () => {
  if (process.env.ELIZA_JSON_JAR) return process.env.ELIZA_JSON_JAR;
  const cache = path.join(
    os.homedir(),
    ".gradle/caches/modules-2/files-2.1/org.json/json/20250517",
  );
  if (!fs.existsSync(cache)) return undefined;
  return fs
    .readdirSync(cache)
    .map((dir) => path.join(cache, dir, "json-20250517.jar"))
    .find((file) => fs.existsSync(file));
};
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

test("embedded agent data, route admission and event streaming pass on the JVM", () => {
  const jar = jsonJar();
  assert.ok(
    jar,
    "Set ELIZA_JSON_JAR to org.json:json:20250517, or resolve that Gradle dependency",
  );
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-embedded-"));
  try {
    execFileSync(
      java("javac"),
      [
        "-cp",
        jar,
        "-d",
        output,
        source("embedded/EmbeddedAgentConfig"),
        source("runtime/LocalRuntimeHttp"),
        source("runtime/RuntimeRequestDeadline"),
        fileURLToPath(new URL("EmbeddedAgentTest.java", import.meta.url)),
      ],
      { timeout: 120000, stdio: "pipe" },
    );
    assert.match(
      execFileSync(
        java("java"),
        [
          "-cp",
          output + path.delimiter + jar,
          "ai.eliza.plugins.agent.embedded.test.EmbeddedAgentTest",
        ],
        { encoding: "utf8", timeout: 120000 },
      ),
      /^PASS embedded agent/m,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
