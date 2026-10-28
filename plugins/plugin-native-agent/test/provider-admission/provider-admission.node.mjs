import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("native provider admission preserves account, expiry, generation and rollback behavior", () => {
  const cache = path.join(
    os.homedir(),
    ".gradle/caches/modules-2/files-2.1/org.json/json/20250517",
  );
  const jar =
    process.env.ELIZA_JSON_JAR ||
    (fs.existsSync(cache)
      ? fs.readdirSync(cache).flatMap((dir) =>
          fs
            .readdirSync(path.join(cache, dir))
            .filter((file) => file === "json-20250517.jar")
            .map((file) => path.join(cache, dir, file)),
        )[0]
      : undefined);
  assert.ok(
    jar,
    "Set ELIZA_JSON_JAR to org.json:json:20250517, or resolve that Gradle dependency",
  );
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-provider-admission-"),
  );
  const java = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  try {
    execFileSync(
      java("javac"),
      [
        "--release",
        "11",
        "-cp",
        jar,
        "-d",
        output,
        fileURLToPath(
          new URL(
            "../../android/src/main/java/ai/eliza/plugins/agent/runtime/NativeProviderAdmission.java",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL("./NativeProviderAdmissionTest.java", import.meta.url),
        ),
      ],
      { timeout: 120000, stdio: "pipe" },
    );
    assert.match(
      execFileSync(
        java("java"),
        [
          "-cp",
          output + path.delimiter + jar,
          "ai.eliza.plugins.agent.runtime.NativeProviderAdmissionTest",
        ],
        { encoding: "utf8", timeout: 120000 },
      ),
      /^PASS local agent provider admission/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
