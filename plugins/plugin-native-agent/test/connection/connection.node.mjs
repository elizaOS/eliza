import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Host-JVM contracts of the shared native connection transport and resident lifecycle
// building blocks (ai.eliza.plugins.agent.connection and runtime). Not Android or device evidence.
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
    .flatMap((dir) =>
      fs
        .readdirSync(path.join(cache, dir))
        .filter((file) => file === "json-20250517.jar")
        .map((file) => path.join(cache, dir, file)),
    )[0];
};
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

test("connection and resident lifecycle JVM contracts pass", () => {
  const jar = jsonJar();
  assert.ok(
    jar,
    "Set ELIZA_JSON_JAR to org.json:json:20250517, or resolve that Gradle dependency",
  );
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-connection-"));
  try {
    const shared = [
      "connection/OwnerRoutePolicy",
      "connection/CloudConnectionPolicy",
      "connection/ConnectionTransport",
      "connection/DelegationCallback",
      "connection/PendingRequests",
      "connection/SecureSlotPolicy",
      "runtime/CredentialIntentFence",
      "runtime/NativeProviderAdmission",
      "runtime/NativeProviderSlot",
      "runtime/NativeRuntimeEmbeddings",
      "runtime/ResidentAttachment",
    ].map(source);
    const tests = fs
      .readdirSync(path.dirname(fileURLToPath(import.meta.url)))
      .filter((name) => name.endsWith(".java"))
      .map((name) => fileURLToPath(new URL(name, import.meta.url)));
    execFileSync(
      java("javac"),
      ["--release", "11", "-cp", jar, "-d", output, ...shared, ...tests],
      { timeout: 120000, stdio: "pipe" },
    );
    for (const [name, pass] of [
      ["OwnerRoutePolicyTest", /^PASS owner route policy/],
      ["CloudConnectionPolicyTest", /^PASS cloud connection policy/],
      ["ConnectionTransportTest", /^PASS connection transport/],
      ["ResidentLifecycleTest", /^PASS resident lifecycle/],
    ]) {
      assert.match(
        execFileSync(
          java("java"),
          [
            "-cp",
            output + path.delimiter + jar,
            `ai.eliza.plugins.agent.connection.test.${name}`,
          ],
          { encoding: "utf8", timeout: 120000 },
        ),
        pass,
      );
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
