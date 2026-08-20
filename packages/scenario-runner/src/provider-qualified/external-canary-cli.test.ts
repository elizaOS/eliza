/**
 * Exercises the real external-canary executable boundary without contacting a
 * provider. The tests prove closed configuration, module pinning, and that an
 * invalid authorization is rejected before trusted operator code is loaded.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
  executeExternalProviderCanaryFromConfig,
  loadPinnedExternalProviderCapabilityModule,
  parseExternalProviderCanaryConfig,
  runExternalProviderCanaryCli,
} from "./external-canary-cli.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(
    path.join(tmpdir(), "eliza-provider-canary-cli-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function validConfig(): Record<string, unknown> {
  return {
    schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
    scenarioFile: "scenario.ts",
    authorizationFile: "authorization.json",
    operationKind: "discord.message-send",
    providerTargetFile: "target.json",
    operationInputFile: "input.json",
    failureProbesFile: "failure-probes.json",
    manifestAuthorityPublicKeyFiles: ["manifest.pub.pem"],
    observerPublicKeyFiles: ["observer.pub.pem"],
    semanticJudgePublicKeyFiles: ["judge.pub.pem"],
    operatorModuleFile: "operator.mjs",
    operatorModuleSha256: "a".repeat(64),
    outputDir: "qualification-output",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("external provider-canary CLI", () => {
  it("accepts only the closed executable config shape", () => {
    expect(parseExternalProviderCanaryConfig(validConfig())).toMatchObject({
      schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
      operationKind: "discord.message-send",
      operatorModuleSha256: "a".repeat(64),
    });
    expect(() =>
      parseExternalProviderCanaryConfig({
        ...validConfig(),
        credential: "must-not-be-accepted",
      }),
    ).toThrow(/unknown=credential/);
    expect(() =>
      parseExternalProviderCanaryConfig({
        ...validConfig(),
        operatorModuleSha256: "not-a-digest",
      }),
    ).toThrow(/lowercase SHA-256/);
    expect(() =>
      parseExternalProviderCanaryConfig({
        ...validConfig(),
        operationKind: "discord.anything",
      }),
    ).toThrow(/operationKind is unsupported/);
  });

  it("loads only the exact pinned operator module bytes", async () => {
    const directory = temporaryDirectory();
    const moduleFile = path.join(directory, "operator.mjs");
    const source =
      "export function createExternalProviderCanaryCapabilities() { return {}; }\n";
    writeFileSync(moduleFile, source);
    const digest = createHash("sha256").update(source).digest("hex");

    const loaded = await loadPinnedExternalProviderCapabilityModule(
      moduleFile,
      digest,
    );
    expect(typeof loaded.createExternalProviderCanaryCapabilities).toBe(
      "function",
    );
    await expect(
      loadPinnedExternalProviderCapabilityModule(moduleFile, "0".repeat(64)),
    ).rejects.toThrow(/digest does not match/);
  });

  it("rejects a module without the capability factory export", async () => {
    const directory = temporaryDirectory();
    const moduleFile = path.join(directory, "operator.mjs");
    const source = "export const unrelated = true;\n";
    writeFileSync(moduleFile, source);
    const digest = createHash("sha256").update(source).digest("hex");

    await expect(
      loadPinnedExternalProviderCapabilityModule(moduleFile, digest),
    ).rejects.toThrow(/must export createExternalProviderCanaryCapabilities/);
  });

  it("refuses invalid authorization before importing operator code", async () => {
    const directory = temporaryDirectory();
    const scenarioFile = path.resolve(
      "../test/scenarios/provider-qualified/provider.discord.confirmed-send.scenario.ts",
    );
    const { publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(
      path.join(directory, "manifest.pub.pem"),
      publicKey.export({ type: "spki", format: "pem" }),
    );
    writeFileSync(path.join(directory, "authorization.json"), "{}\n");
    writeFileSync(
      path.join(directory, "target.json"),
      `${JSON.stringify({ guildId: "123456789012345678", channelId: "223456789012345678" })}\n`,
    );
    writeFileSync(
      path.join(directory, "input.json"),
      `${JSON.stringify({ text: "operator canary", attachments: [] })}\n`,
    );
    writeFileSync(path.join(directory, "failure-probes.json"), "[{}, {}]\n");
    writeFileSync(path.join(directory, "observer.pub.pem"), "unused\n");
    writeFileSync(path.join(directory, "judge.pub.pem"), "unused\n");
    const config = {
      ...validConfig(),
      scenarioFile,
    };
    const configFile = path.join(directory, "config.json");
    writeFileSync(configFile, `${JSON.stringify(config)}\n`);
    const loadOperatorModule = vi.fn();

    await expect(
      executeExternalProviderCanaryFromConfig(configFile, {
        loadOperatorModule,
      }),
    ).rejects.toThrow(/operator authorization/);
    expect(loadOperatorModule).not.toHaveBeenCalled();
  });

  it("returns usage status before touching a config file", async () => {
    await expect(runExternalProviderCanaryCli([])).resolves.toBe(2);
    await expect(
      runExternalProviderCanaryCli(["one.json", "two.json"]),
    ).resolves.toBe(2);
  });
});
