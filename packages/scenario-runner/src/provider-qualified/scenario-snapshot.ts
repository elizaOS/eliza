/**
 * Serializes and parses executable-free provider-canary definitions at the
 * credential boundary. The snapshot is canonical JSON bound to the exact
 * repository canary and operation, so protected execution never imports a
 * checkout-selected TypeScript module.
 */

import {
  type ScenarioDefinition,
  scenario,
} from "@elizaos/scenario-runner/schema";
import providerCanaryDefinitionCatalog from "../../schema/provider-canary-definitions.json" with {
  type: "json",
};
import {
  type ProviderCanaryControllerContract,
  providerCanaryControllerContract,
} from "./controller-registry.ts";
import { canonicalJson, canonicalJsonValue } from "./manifest.ts";
import type { ProviderOperationKind } from "./operation-binding.ts";

const SCENARIO_DEFINITION_FIELDS = new Set([
  "id",
  "title",
  "description",
  "domain",
  "lane",
  "executionProfile",
  "evidenceScope",
  "isolation",
  "requires",
  "tags",
  "turns",
  "finalChecks",
]);

function validateProviderScenarioContract(
  definition: ScenarioDefinition,
  expectedOperationKind: ProviderOperationKind,
): ProviderCanaryControllerContract {
  const contract = providerCanaryControllerContract(definition.id);
  if (contract.operationKind !== expectedOperationKind) {
    throw new Error(
      "provider canary scenario snapshot does not match its canonical operation kind",
    );
  }
  if (
    definition.domain !== "provider-canary" ||
    definition.lane !== "live-only" ||
    definition.executionProfile !== "provider-qualified" ||
    definition.evidenceScope !== "provider-certification" ||
    definition.isolation !== "per-scenario"
  ) {
    throw new Error(
      "provider canary scenario snapshot has an invalid qualification classification",
    );
  }
  return contract;
}

function validateScenarioDefinition(
  value: unknown,
  expectedOperationKind: ProviderOperationKind,
): ScenarioDefinition {
  const snapshot = canonicalJsonValue(
    value,
    "providerCanaryScenarioDefinition",
  );
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new Error("provider canary scenario snapshot must be an object");
  }
  const unknownFields = Object.keys(snapshot).filter(
    (key) => !SCENARIO_DEFINITION_FIELDS.has(key),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `provider canary scenario snapshot has unknown fields: ${unknownFields.join(",")}`,
    );
  }
  const definition = scenario(snapshot as unknown as ScenarioDefinition);
  validateProviderScenarioContract(definition, expectedOperationKind);
  return definition;
}

function canonicalCatalogDefinition(
  id: string,
  expectedOperationKind: ProviderOperationKind,
): ScenarioDefinition {
  if (
    providerCanaryDefinitionCatalog.schema !==
      "eliza.provider-canary-definition-catalog.v1" ||
    providerCanaryDefinitionCatalog.scenarios.length !== 13
  ) {
    throw new Error("provider canary scenario-definition catalog is invalid");
  }
  const ids = providerCanaryDefinitionCatalog.scenarios.map(
    (definition) => definition.id,
  );
  if (new Set(ids).size !== ids.length || !ids.includes(id)) {
    throw new Error(
      "provider canary scenario-definition catalog does not contain the exact scenario",
    );
  }
  const definition = providerCanaryDefinitionCatalog.scenarios.find(
    (candidate) => candidate.id === id,
  );
  if (definition === undefined) {
    throw new Error(
      "provider canary scenario-definition catalog is missing the scenario",
    );
  }
  return validateScenarioDefinition(definition, expectedOperationKind);
}

function canonicalScenarioDefinition(
  value: unknown,
  expectedOperationKind: ProviderOperationKind,
): ScenarioDefinition {
  const definition = validateScenarioDefinition(value, expectedOperationKind);
  const canonical = canonicalCatalogDefinition(
    definition.id,
    expectedOperationKind,
  );
  if (
    canonicalJson(
      canonicalJsonValue(definition, "providerCanaryScenarioDefinition"),
    ) !==
    canonicalJson(
      canonicalJsonValue(canonical, "canonicalProviderCanaryDefinition"),
    )
  ) {
    throw new Error(
      "provider canary scenario snapshot differs from the repository-owned canonical definition",
    );
  }
  return definition;
}

/** Produce the exact executable-free bytes distributed with an authorization. */
export function createProviderCanaryScenarioSnapshot(input: {
  definition: ScenarioDefinition;
  operationKind: ProviderOperationKind;
}): Buffer {
  const definition = canonicalScenarioDefinition(
    input.definition,
    input.operationKind,
  );
  return Buffer.from(
    `${canonicalJson(
      canonicalJsonValue(definition, "providerCanaryScenarioDefinition"),
    )}\n`,
    "utf8",
  );
}

/** Parse only canonical UTF-8 JSON bytes; executable modules are never accepted. */
export function parseProviderCanaryScenarioSnapshot(input: {
  bytes: Uint8Array;
  operationKind: ProviderOperationKind;
}): ScenarioDefinition {
  const bytes = Buffer.from(input.bytes);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("provider canary scenario snapshot must be UTF-8 JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // error-policy:J2 Preserve the data-only boundary without evaluating code.
    throw new Error("provider canary scenario snapshot is invalid JSON", {
      cause: error,
    });
  }
  const definition = canonicalScenarioDefinition(parsed, input.operationKind);
  const canonical = createProviderCanaryScenarioSnapshot({
    definition,
    operationKind: input.operationKind,
  });
  if (!canonical.equals(bytes)) {
    throw new Error(
      "provider canary scenario snapshot must use canonical JSON with one trailing newline",
    );
  }
  return definition;
}
