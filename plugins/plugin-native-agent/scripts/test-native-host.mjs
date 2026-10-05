import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-native-host-"));
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
try {
  execFileSync(
    process.execPath,
    [
      "--test",
      path.join(root, "test/native-host/android-runtime-inventory.node.mjs"),
      path.join(root, "test/native-host/local-credential-client.node.mjs"),
      path.join(root, "test/native-host/gateway-artifact.node.mjs"),
      path.join(root, "test/native-host/updater-contract-fixtures.node.mjs"),
    ],
    { stdio: "inherit", timeout: 60000 },
  );
  const shared = [
    "runtime/RuntimeBundleStore",
    "runtime/RuntimeAssets",
    "runtime/PrivateOAuthCallback",
    "runtime/NativeProcessSupervisor",
    "runtime/NativeRuntimeSession",
    "runtime/NativeProcessLog",
    "runtime/RuntimePrivateFiles",
    "runtime/InstalledRuntimeLibraries",
    "runtime/EmbeddedRuntimeLaunch",
    "runtime/EmbeddedRuntimeGroup",
    "runtime/RuntimeRequestDeadline",
    "runtime/RuntimeRequestDispatcher",
    "runtime/RuntimeInstallationIdentity",
    "updater/UpdateJournal",
    "updater/QualifiedClockAnchor",
    "updater/JobRunRegistry",
    "updater/PreparationFlow",
    "updater/PreparedRecovery",
    "updater/PreparedAuthorizationStore",
  ].map((name) =>
    path.join(
      root,
      "android/src/main/java/ai/eliza/plugins/agent",
      `${name}.java`,
    ),
  );
  const tests = fs
    .readdirSync(path.join(root, "test/native-host"))
    .filter((name) => name.endsWith(".java"))
    .map((name) => path.join(root, "test/native-host", name));
  execFileSync(bin("javac"), ["-d", output, ...shared, ...tests], {
    stdio: "inherit",
    timeout: 60000,
  });
  for (const [group, name] of [
    ["runtime.test", "RuntimeBundleStoreTest"],
    ["runtime.test", "RuntimeAssetsTest"],
    ["runtime.test", "PrivateOAuthCallbackTest"],
    ["runtime.test", "NativeProcessSupervisorTest"],
    ["runtime.test", "NativeRuntimeSessionTest"],
    ["runtime.test", "NativeProcessLogTest"],
    ["runtime.test", "RuntimePrivateFilesTest"],
    ["runtime.test", "InstalledRuntimeLibrariesTest"],
    ["runtime.test", "EmbeddedRuntimeLaunchTest"],
    ["runtime.test", "EmbeddedRuntimeGroupTest"],
    ["runtime.test", "RuntimeRequestDeadlineTest"],
    ["runtime.test", "RuntimeRequestDispatcherTest"],
    ["updater", "UpdateJournalTest"],
    ["updater", "ProbationWindowTest"],
    ["updater", "QualifiedClockAnchorTest"],
    ["updater", "JobRunRegistryTest"],
    ["updater", "PreparationFlowTest"],
    ["updater", "PreparedRecoveryTest"],
    ["updater", "PreparedAuthorizationStoreTest"],
  ]) {
    execFileSync(
      bin("java"),
      [
        "-cp",
        output,
        `ai.eliza.plugins.agent.${group}.${name}`,
        path.join(output, name),
      ],
      { stdio: "inherit", timeout: 60000 },
    );
  }
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
