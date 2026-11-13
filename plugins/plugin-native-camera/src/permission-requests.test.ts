import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the actual native pending-call owner on the JVM", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = mkdtempSync(path.join(tmpdir(), "camera-permission-"));
  const tool = (name: string) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  try {
    execFileSync(
      tool("javac"),
      [
        "-d",
        output,
        path.join(
          root,
          "android/src/main/java/ai/eliza/plugins/camera/CameraPermissionRequests.java",
        ),
        path.join(root, "test/native-host/CameraPermissionRequestsTest.java"),
      ],
      { stdio: "pipe" },
    );
    expect(
      execFileSync(
        tool("java"),
        ["-cp", output, "ai.eliza.plugins.camera.CameraPermissionRequestsTest"],
        { encoding: "utf8" },
      ),
    ).toContain("PASS exact camera alias");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
