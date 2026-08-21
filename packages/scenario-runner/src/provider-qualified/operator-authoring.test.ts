/**
 * Exercises the offline operator authoring boundary against real private files
 * and the statically parsed 13-canary corpus, without provider execution.
 */

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_CANARY_SCENARIOS } from "../../../test/scenarios/provider-qualified/_provider-canary-catalog.ts";
import { providerCanaryControllerContract } from "./controller-registry.ts";
import {
  canonicalProviderCanaryDefinition,
  initializeProviderOperatorDirectory,
  PROVIDER_OPERATOR_INPUT_JSON_SCHEMA,
  PROVIDER_OPERATOR_PLAN_JSON_SCHEMA,
  PROVIDER_OPERATOR_PROBES_JSON_SCHEMA,
  PROVIDER_OPERATOR_TARGET_JSON_SCHEMA,
  preflightProviderCanaryInventory,
  preflightProviderOperatorDirectory,
  prepareProviderCanaryRunDirectory,
} from "./operator-authoring.ts";
import { runProviderOperatorCli } from "./operator-authoring-cli.ts";
import { createProviderCanaryScenarioSnapshot } from "./scenario-snapshot.ts";

const SCENARIO_DIRECTORY = fileURLToPath(
  new URL("../../../test/scenarios/provider-qualified/", import.meta.url),
);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "eliza-provider-operator-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("provider operator authoring", () => {
  it("publishes four closed JSON schemas, including nested operation objects", () => {
    expect(Array.isArray(PROVIDER_OPERATOR_TARGET_JSON_SCHEMA.oneOf)).toBe(
      true,
    );
    expect(Array.isArray(PROVIDER_OPERATOR_INPUT_JSON_SCHEMA.oneOf)).toBe(true);
    const targetAlternatives =
      PROVIDER_OPERATOR_TARGET_JSON_SCHEMA.oneOf as Array<{
        additionalProperties: boolean;
        properties: { providerTarget: { additionalProperties: boolean } };
      }>;
    expect(targetAlternatives).toHaveLength(13);
    expect(
      targetAlternatives.every((entry) => entry.additionalProperties === false),
    ).toBe(true);
    expect(
      targetAlternatives.every(
        (entry) =>
          entry.properties.providerTarget.additionalProperties === false,
      ),
    ).toBe(true);
    expect(PROVIDER_OPERATOR_PROBES_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      properties: { probes: { minItems: 2, maxItems: 2 } },
    });
    expect(PROVIDER_OPERATOR_PLAN_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      properties: { authorization: { additionalProperties: false } },
    });
  });

  it("creates private, deliberately non-runnable material and refuses overwrite", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of [
      "target.json",
      "input.json",
      "probes.json",
      "scenario.json",
      "plan.json",
    ]) {
      const file = path.join(directory, name);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      if (name !== "scenario.json") {
        expect(await readFile(file, "utf8")).toContain("__REPLACE_WITH_");
      }
    }
    await expect(preflightProviderOperatorDirectory(directory)).rejects.toThrow(
      "non-runnable operator placeholder",
    );
    await expect(
      initializeProviderOperatorDirectory({
        directory,
        scenarioId: "provider.gmail.confirmed-send",
        scenarioDirectory: SCENARIO_DIRECTORY,
      }),
    ).rejects.toThrow();
  });

  it("preflights one concrete operation, two probes, and all 13 static snapshots", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    await writeJson(path.join(directory, "target.json"), {
      schema: "eliza.provider-canary-operator-target.v1",
      scenarioId: "provider.gmail.confirmed-send",
      kind: "gmail.email-send",
      providerTarget: { recipientEmail: "operator-recipient@example.test" },
    });
    await writeJson(path.join(directory, "input.json"), {
      schema: "eliza.provider-canary-operator-input.v1",
      scenarioId: "provider.gmail.confirmed-send",
      kind: "gmail.email-send",
      operationInput: {
        subject: "elizaOS provider canary",
        bodyText: "Gmail provider canary delivery",
        cc: [],
        bcc: [],
      },
    });
    await writeJson(path.join(directory, "probes.json"), {
      schema: "eliza.provider-canary-operator-probes.v1",
      scenarioId: "provider.gmail.confirmed-send",
      probes: [
        {
          probeId: "gmail-auth-denied",
          requestPayload: { subject: "denied" },
          expectedErrorCode: "insufficient-scope",
          scope: { account: "operator-canary" },
          authorizationGrant: { grant: "denied" },
        },
        {
          probeId: "gmail-provider-rejected",
          requestPayload: { recipient: "invalid" },
          expectedErrorCode: "invalid-recipient",
          scope: { account: "operator-canary" },
          authorizationGrant: { grant: "send" },
        },
      ],
    });
    await writeJson(path.join(parent, "authorization.json"), {
      signed: "authorization-placeholder-for-file-shape-test",
    });
    await Promise.all(
      ["authority.pem", "observer.pem", "semantic.pem"].map((name) =>
        writeFile(path.join(parent, name), `public-${name}\n`),
      ),
    );
    const operatorModule = Buffer.from(
      "export async function createExternalProviderCanaryCapabilities() { throw new Error('not executed'); }\n",
    );
    await writeFile(path.join(parent, "operator.mjs"), operatorModule);
    await mkdir(path.join(parent, "state"), { mode: 0o700 });
    const operatorModuleSha256 = createHash("sha256")
      .update(operatorModule)
      .digest("hex");
    await writeJson(path.join(directory, "plan.json"), {
      schema: "eliza.provider-canary-operator-plan.v1",
      scenarioId: "provider.gmail.confirmed-send",
      operationKind: "gmail.email-send",
      targetFile: "target.json",
      inputFile: "input.json",
      probesFile: "probes.json",
      scenarioDefinitionFile: "scenario.json",
      scenarioDirectory: SCENARIO_DIRECTORY,
      authorization: {
        manifestAuthorityKeyId: "a".repeat(64),
        signerProvider: "protected-hsm",
      },
      execution: {
        authorizationFile: "../authorization.json",
        manifestAuthorityPublicKeyFiles: ["../authority.pem"],
        observerPublicKeyFiles: ["../observer.pem"],
        semanticJudgePublicKeyFiles: ["../semantic.pem"],
        operatorModuleFile: "../operator.mjs",
        operatorModuleSha256,
        operatorStateDir: "../state",
        outputDir: "../output",
      },
    });
    const result = await preflightProviderOperatorDirectory(directory);
    expect(result).toMatchObject({
      status: "operator-material-preflight-passed",
      scenarioId: "provider.gmail.confirmed-send",
      operation: { kind: "gmail.email-send" },
    });
    expect(result.probeBindings).toHaveLength(2);
    expect(result.inventory).toHaveLength(13);
    const runDirectory = path.join(parent, "prepared");
    const config = await prepareProviderCanaryRunDirectory({
      authoringDirectory: directory,
      runDirectory,
    });
    expect(config).toMatchObject({
      schema: "eliza.external-provider-canary-config.v2",
      scenarioDefinitionFile: "scenario.json",
      providerTargetFile: "target.json",
      operationInputFile: "input.json",
      failureProbesFile: "probes.json",
    });
    expect(
      JSON.parse(
        await readFile(path.join(runDirectory, "target.json"), "utf8"),
      ),
    ).toEqual({
      recipientEmail: "operator-recipient@example.test",
    });
    expect((await stat(runDirectory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(runDirectory)) {
      expect((await stat(path.join(runDirectory, name))).mode & 0o777).toBe(
        0o600,
      );
    }
    const plan = JSON.parse(
      await readFile(path.join(directory, "plan.json"), "utf8"),
    ) as { execution: { observerPublicKeyFiles: string[] } };
    plan.execution.observerPublicKeyFiles = ["../missing-observer.pem"];
    await writeJson(path.join(directory, "plan.json"), plan);
    const refusedDirectory = path.join(parent, "refused");
    await expect(
      prepareProviderCanaryRunDirectory({
        authoringDirectory: directory,
        runDirectory: refusedDirectory,
      }),
    ).rejects.toThrow();
    await expect(stat(refusedDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(parent, ".refused.staging")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(parent, 0o777);
    await expect(
      prepareProviderCanaryRunDirectory({
        authoringDirectory: directory,
        runDirectory: path.join(parent, "unsafe-parent-run"),
      }),
    ).rejects.toThrow("must not be group- or world-writable");
    await chmod(parent, 0o700);
  });

  it("detects inventory drift without importing scenario modules", async () => {
    const snapshots =
      await preflightProviderCanaryInventory(SCENARIO_DIRECTORY);
    expect(snapshots.map(({ scenarioId }) => scenarioId)).toHaveLength(13);
    expect(
      new Set(snapshots.map(({ operationKind }) => operationKind)).size,
    ).toBe(13);
  });

  it("ratchets all 13 checked-in definitions against the executable catalog", async () => {
    for (const definition of PROVIDER_CANARY_SCENARIOS) {
      const canonical = await canonicalProviderCanaryDefinition(
        definition.id as never,
      );
      const operationKind = providerCanaryControllerContract(
        definition.id,
      ).operationKind;
      expect(
        createProviderCanaryScenarioSnapshot({
          definition: canonical,
          operationKind,
        }),
      ).toEqual(
        createProviderCanaryScenarioSnapshot({ definition, operationKind }),
      );
    }
  });

  it("refuses symlinked private material", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    const target = path.join(directory, "target.json");
    const outside = path.join(parent, "outside.json");
    await writeJson(outside, {});
    await unlink(target);
    await symlink(outside, target);
    await expect(preflightProviderOperatorDirectory(directory)).rejects.toThrow(
      "must not be a symbolic link",
    );
  });

  it("sanitizes invalid private JSON without echoing its path or content", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    await writeFile(
      path.join(directory, "target.json"),
      '{"privateToken":"must-not-escape"',
    );
    let message = "";
    try {
      await preflightProviderOperatorDirectory(directory);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("private JSON document is unreadable or invalid");
    expect(message).not.toContain("must-not-escape");
    expect(message).not.toContain(directory);
  });

  it("shows explicit help and rejects credential-shaped CLI flags", async () => {
    let output = "";
    await expect(
      runProviderOperatorCli(["help"], {
        stdout: (message) => {
          output += message;
        },
      }),
    ).resolves.toBe(0);
    expect(output).toContain("init <directory>");
    expect(output).toContain("preflight <directory>");
    expect(output).toContain("never accepts private PEM");
    await expect(
      runProviderOperatorCli([
        "init",
        "private",
        "--scenario",
        "provider.gmail.confirmed-send",
        "--scenarios",
        SCENARIO_DIRECTORY,
        "--private-key",
        "secret.pem",
      ]),
    ).rejects.toThrow("unsupported flag --private-key");
  });
});
