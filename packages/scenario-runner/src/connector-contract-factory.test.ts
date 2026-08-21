/** Verifies that simulated connector contracts cannot claim externally observed provider evidence. */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConnectorContractScenario } from "../../test/scenarios/connector-contracts/_factory.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("connector contract scenario factory", () => {
  it("labels generated scenarios as simulated and requires a meaningful judge score", () => {
    const generated = buildConnectorContractScenario({
      evidenceScope: "connector-contract",
      id: "connector.example.contract-core",
      title: "Exercise the example connector contract",
      connector: "example",
      axis: "core",
      description: "Example connector workflow.",
      turns: [
        {
          name: "example-core",
          text: "Perform the example workflow.",
          responseIncludesAny: ["performed"],
          expectedActions: ["EXAMPLE_ACTION"],
        },
      ],
    });

    expect(generated.executionProfile).toBe("simulated");
    expect(generated.evidenceScope).toBe("connector-contract");
    expect(generated.domain).toBe("connector-contract");
    expect(generated.tags).toContain("connector-contract");
    expect(generated.tags).not.toContain("connector-certification");
    expect(generated.tags).toContain("simulated-connector-contract");
    expect(generated.title).toMatch(/^Simulated connector contract:/);
    expect(generated.status).toBe("pending");
    expect(generated.description).toContain("fixture-backed evidence only");
    expect(generated.turns[0]?.text).toContain("not provider-qualified");
    expect(generated.turns[0]?.text).not.toContain("real connector path");

    const rubric = generated.finalChecks?.find(
      (check) => check.type === "judgeRubric",
    );
    expect(rubric).toMatchObject({
      type: "judgeRubric",
      minimumScore: 0.7,
    });
    if (rubric?.type === "judgeRubric") {
      expect(rubric.rubric).toContain("does not prove real-provider");
    }
  });

  it("truth-labels every gateway scenario as a deterministic domain contract", async () => {
    const gatewayRoot = resolve(repoRoot, "packages/test/scenarios/gateway");
    const files = readdirSync(gatewayRoot)
      .filter((entry) => entry.endsWith(".scenario.ts"))
      .sort();

    expect(files).toHaveLength(10);
    for (const file of files) {
      const path = resolve(gatewayRoot, file);
      const source = readFileSync(path, "utf8");
      expect(source.split("\n", 1)[0], file).toContain("Proves");

      const loaded = (await import(pathToFileURL(path).href)) as {
        default: {
          title: string;
          domain: string;
          description?: string;
          tags?: readonly string[];
          executionProfile?: string;
          evidenceScope?: string;
          lane?: string;
          status?: string;
        };
      };
      const generated = loaded.default;
      expect(generated.executionProfile, file).toBe("simulated");
      expect(generated.evidenceScope, file).toBe("domain-contract");
      expect(generated.lane, file).toBe("pr-deterministic");
      expect(generated.domain, file).toBe("gateway-contract");
      expect(generated.tags, file).toContain("deterministic-contract");
      expect(generated.title, file).not.toMatch(/^Simulated gateway contract:/);
      expect(generated.description, file).toMatch(
        /does not claim|does not place/i,
      );
      expect(generated.status, file).toBeUndefined();
    }
  });

  it("retires replaced or removed claims while requiring active Drive effect coverage", async () => {
    const connectorRoot = resolve(
      repoRoot,
      "packages/test/scenarios/connector-contracts",
    );
    for (const file of [
      "connector.browser-portal.contract-core.scenario.ts",
      "connector.calendly.contract-core.scenario.ts",
      "connector.notifications.contract-core.scenario.ts",
    ]) {
      expect(
        () => readFileSync(resolve(connectorRoot, file), "utf8"),
        file,
      ).toThrow();
    }

    const defaultPack = readFileSync(
      resolve(
        repoRoot,
        "plugins/plugin-personal-assistant/src/lifeops/connectors/default-pack.ts",
      ),
      "utf8",
    );
    expect(defaultPack).not.toContain("createCalendlyConnectorContribution");

    const driveDomain = readFileSync(
      resolve(
        repoRoot,
        "plugins/plugin-personal-assistant/src/lifeops/domains/drive-service.ts",
      ),
      "utf8",
    );
    expect(driveDomain).toContain("async createDriveFile(");
    expect(driveDomain).toContain("async updateSheetCells(");

    const drivePath = resolve(
      connectorRoot,
      "connector.google-drive-docs-sheets.contract-core.scenario.ts",
    );
    const loaded = (await import(pathToFileURL(drivePath).href)) as {
      default: {
        status?: string;
        lane?: string;
        pendingReason?: string;
        turns: Array<{ actionName?: string }>;
        finalChecks?: Array<{ type: string; name?: string }>;
      };
    };
    expect(loaded.default.status).toBeUndefined();
    expect(loaded.default.pendingReason).toBeUndefined();
    expect(loaded.default.lane).toBe("pr-deterministic");
    expect(loaded.default.turns).toHaveLength(6);
    expect(
      loaded.default.turns.every(
        (turn) => turn.actionName === "GOOGLE_WORKSPACE",
      ),
    ).toBe(true);
    expect(loaded.default.finalChecks).toContainEqual(
      expect.objectContaining({
        type: "custom",
        name: "exact-drive-sheets-effects-and-readback",
      }),
    );

    const workspaceAction = readFileSync(
      resolve(
        repoRoot,
        "plugins/plugin-personal-assistant/src/actions/google-workspace.ts",
      ),
      "utf8",
    );
    expect(workspaceAction).toContain('const ACTION_NAME = "GOOGLE_WORKSPACE"');
    expect(workspaceAction).toContain("service.createDriveFile");
    expect(workspaceAction).toContain("service.updateSheetCells");

    const browserAction = readFileSync(
      resolve(repoRoot, "plugins/plugin-browser/src/actions/browser.ts"),
      "utf8",
    );
    expect(browserAction).not.toMatch(
      /BrowserActionSubaction[\s\S]*?\| "upload"/,
    );
  });
});
