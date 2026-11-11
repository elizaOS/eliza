import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-native-host-"));
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
let primaryFailure;
let failed = false;
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
    "runtime/NativeRuntimeEmbeddings",
    "updater/UpdateJournal",
    "updater/CommitFreshness",
    "updater/InstallReadback",
    "updater/RuntimeUpdatePause",
    "updater/QualifiedClockAnchor",
    "updater/JobRunRegistry",
    "updater/PreparationFlow",
    "updater/PreparedRecovery",
    "updater/PreparedAuthorizationStore",
    "updater/policy/ComfortWindow",
    "updater/policy/DeviceSignals",
    "updater/policy/OtaGates",
    "updater/policy/OtaPolicy",
    "updater/policy/PolicyEngine",
    "updater/policy/PolicyLedger",
    "updater/policy/PolicyStore",
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
    ["runtime.test", "NativeRuntimeEmbeddingsTest"],
    ["updater", "UpdateJournalTest"],
    ["updater", "UpdateJournalConformanceTest"],
    ["updater", "InstallReadbackTest"],
    ["updater", "RuntimeUpdatePauseTest"],
    ["updater", "ProbationWindowTest"],
    ["updater", "QualifiedClockAnchorTest"],
    ["updater", "JobRunRegistryTest"],
    ["updater", "PreparationFlowTest"],
    ["updater", "PreparedRecoveryTest"],
    ["updater", "PreparedAuthorizationStoreTest"],
    ["updater.policy", "OtaPolicyTest"],
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
} catch (error) {
  failed = true;
  primaryFailure = error;
}
try {
  fs.rmSync(output, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
} catch (cleanupError) {
  if (failed) {
    // Report cleanup without replacing the compiler/test failure it followed.
    console.error("Native harness cleanup also failed:", cleanupError);
  } else {
    failed = true;
    primaryFailure = cleanupError;
  }
}
if (failed) throw primaryFailure;
