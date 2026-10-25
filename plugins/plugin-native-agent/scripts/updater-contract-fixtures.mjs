import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const namespace = "ai.eliza.plugins.agent.updater";
const contracts = new Map([
  ["JobRunRegistryTest", ["JobRunRegistry"]],
  [
    "PreparationFlowTest",
    ["UpdateJournal", "JobRunRegistry", "PreparationFlow"],
  ],
  ["ProbationWindowTest", ["UpdateJournal"]],
  ["QualifiedClockAnchorTest", ["QualifiedClockAnchor"]],
  ["UpdateJournalTest", ["UpdateJournal"]],
]);

/** Source-checkout test API. Rebind the canonical contract to a consumer's thin
 * Java adapters without maintaining a second copy of its assertions. No
 * production source is rewritten, compiled or executed by this helper. */
export function stageUpdaterContractFixture({
  fixture,
  packageName,
  outputDirectory,
}) {
  const dependencies = contracts.get(fixture);
  if (!dependencies) throw new Error("Unknown updater contract fixture");
  if (
    typeof packageName !== "string" ||
    packageName.length > 255 ||
    !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(packageName)
  )
    throw new Error("Invalid Java fixture package");
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory))
    throw new Error("Fixture output directory must be absolute");
  const original = fs.readFileSync(
    path.join(root, "test/native-host", `${fixture}.java`),
    "utf8",
  );
  if (!original.startsWith(`package ${namespace};\n`))
    throw new Error("Updater fixture package contract changed");
  // Includes static imports so assertions exercise the consumer adapter types.
  const source = original.replaceAll(namespace, packageName);
  const file = path.join(outputDirectory, `${fixture}.java`);
  fs.writeFileSync(file, source, { flag: "wx" });
  return {
    file,
    mainClass: `${packageName}.${fixture}`,
    canonicalSha256: createHash("sha256").update(original).digest("hex"),
    sharedSources: dependencies.map((name) =>
      path.join(
        root,
        "android/src/main/java/ai/eliza/plugins/agent/updater",
        `${name}.java`,
      ),
    ),
  };
}

/** Execute the canonical contract against shared classes or same-named consumer
 * adapters. Compiler and JVM failures propagate; every run owns a fresh directory. */
export function runUpdaterContractFixture({
  fixture,
  packageName = namespace,
  adaptersDirectory,
  javaHome = process.env.JAVA_HOME,
  processTimeoutMs,
}) {
  if (!Number.isSafeInteger(processTimeoutMs) || processTimeoutMs <= 0)
    throw new Error("A positive process timeout is required");
  if (
    adaptersDirectory !== undefined &&
    (typeof adaptersDirectory !== "string" ||
      !path.isAbsolute(adaptersDirectory) ||
      packageName === namespace)
  )
    throw new Error(
      "Consumer adapters require an absolute directory and distinct package",
    );
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-updater-contract-"),
  );
  const binary = (name) => (javaHome ? path.join(javaHome, "bin", name) : name);
  try {
    const contract = stageUpdaterContractFixture({
      fixture,
      packageName,
      outputDirectory,
    });
    const adapters =
      adaptersDirectory === undefined
        ? []
        : contract.sharedSources.map((file) =>
            path.join(adaptersDirectory, path.basename(file)),
          );
    execFileSync(
      binary("javac"),
      [
        "-d",
        outputDirectory,
        ...contract.sharedSources,
        ...adapters,
        contract.file,
      ],
      { encoding: "utf8", timeout: processTimeoutMs },
    );
    const stdout = execFileSync(
      binary("java"),
      [
        "-cp",
        outputDirectory,
        contract.mainClass,
        path.join(outputDirectory, "cases"),
      ],
      { encoding: "utf8", timeout: processTimeoutMs },
    );
    return {
      stdout,
      mainClass: contract.mainClass,
      canonicalSha256: contract.canonicalSha256,
    };
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}
