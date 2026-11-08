import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveOrgJsonJar } from "../../../../packages/scripts/lib/org-json-jar.mjs";

test("native provider admission preserves account, expiry, generation and rollback behavior", () => {
  const { jar, reason } = resolveOrgJsonJar();
  assert.ok(jar, reason);
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
        fileURLToPath(
          new URL(
            "../../android/src/main/java/ai/eliza/plugins/agent/runtime/CredentialShutdownLease.java",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL(
            "../../android/src/main/java/ai/eliza/plugins/agent/runtime/CredentialIntentFence.java",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL(
            "../../../plugin-native-secure-store/android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly/CredentialIntentFence.java",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL(
            "../../../plugin-native-secure-store/android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly/CredentialSlotMutation.java",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL(
            "../../../plugin-native-secure-store/android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly/CredentialMutationConductor.java",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL(
            "../../android/src/main/java/ai/eliza/plugins/agent/runtime/ResidentCredentialStore.java",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL("./ResidentCredentialConductorTest.java", import.meta.url),
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
    assert.match(
      execFileSync(
        java("java"),
        [
          "-cp",
          output + path.delimiter + jar,
          "ai.eliza.plugins.agent.runtime.ResidentCredentialConductorTest",
        ],
        { encoding: "utf8", timeout: 30000 },
      ),
      /^PASS shared resident credential conductor/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
