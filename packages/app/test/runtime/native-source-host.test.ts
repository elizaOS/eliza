import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("native source host denies unavailable callbacks and foreign app UIDs", {
  skip: !process.env.ELIZA_JSON_JAR,
}, () => {
  const root = resolve(import.meta.dirname, "../../../.."),
    temporary = mkdtempSync(join(tmpdir(), "native-source-host-"));
  const java =
    process.env.JAVA_HOME ||
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home";
  try {
    execFileSync(join(java, "bin/javac"), [
      "--release",
      "11",
      "-cp",
      process.env.ELIZA_JSON_JAR!,
      "-d",
      temporary,
      join(
        root,
        "packages/app/platforms/android/app/src/main/java/ai/elizaos/app/NativeSourceHost.java",
      ),
      join(
        root,
        "packages/app/test/fixtures/native-source/NativeSourceHostTest.java",
      ),
    ]);
    expect(
      execFileSync(
        join(java, "bin/java"),
        [
          "-cp",
          temporary + ":" + process.env.ELIZA_JSON_JAR,
          "ai.elizaos.app.NativeSourceHostTest",
        ],
        { encoding: "utf8" },
      ),
    ).toMatch(/^PASS native source host/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
