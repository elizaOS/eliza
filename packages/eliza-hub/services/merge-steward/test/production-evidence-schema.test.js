import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { validateProductionEvidenceShape } from "../src/production-evidence-schema.js";
import { completeEvidence } from "./production-gate-fixtures.js";

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const SCHEMA_URL = new URL(
  "../production-evidence.schema.json",
  import.meta.url,
);
const TEMPLATE_URL = new URL(
  "../../../deployment/hetzner-staging/release/production-evidence.example.json",
  import.meta.url,
);

describe("production evidence schema", () => {
  it("is exported by the package and referenced by the checked-in template", async () => {
    const packageJson = await readJson(PACKAGE_JSON_URL);
    const schema = await readJson(SCHEMA_URL);
    const template = await readJson(TEMPLATE_URL);

    assert.equal(
      packageJson.exports["./production-evidence.schema.json"],
      "./production-evidence.schema.json",
    );
    assert.equal(
      template.$schema,
      "../../../services/merge-steward/production-evidence.schema.json",
    );
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(schema.title, "Eliza Hub Production Evidence");
  });

  it("covers every top-level evidence section used by the production gate", async () => {
    const schema = await readJson(SCHEMA_URL);
    const evidence = completeEvidence();
    const evidenceSections = Object.keys(evidence);

    assert.deepEqual(schema.required, evidenceSections);
    assert.deepEqual(
      Object.keys(schema.properties).filter((key) => key !== "$schema"),
      evidenceSections,
    );

    for (const section of evidenceSections) {
      assertEvidenceObjectCovered(
        evidence[section],
        schema.properties[section],
        section,
      );
    }
  });

  it("keeps the release template shaped like production evidence", async () => {
    const schema = await readJson(SCHEMA_URL);
    const template = await readJson(TEMPLATE_URL);
    const templateSections = Object.keys(template).filter(
      (key) => key !== "$schema",
    );

    assert.deepEqual(templateSections, schema.required);

    for (const section of templateSections) {
      assertEvidenceObjectCovered(
        template[section],
        schema.properties[section],
        section,
      );
    }
  });

  it("does not duplicate required evidence fields in schema sections", async () => {
    const schema = await readJson(SCHEMA_URL);

    assert.deepEqual(
      duplicates(schema.required),
      [],
      "top-level required sections are duplicated",
    );

    for (const [section, sectionSchema] of Object.entries(schema.properties)) {
      assert.deepEqual(
        duplicates(sectionSchema.required),
        [],
        `${section}.required has duplicates`,
      );
    }
  });

  it("keeps backup component evidence aligned with the gate fixture", async () => {
    const schema = await readJson(SCHEMA_URL);
    const backupComponents =
      schema.properties.backups.properties.includes.items.enum;

    assert.deepEqual(backupComponents, completeEvidence().backups.includes);
  });

  it("validates complete evidence and the failing release template as structurally valid", async () => {
    const template = await readJson(TEMPLATE_URL);

    assert.deepEqual(validateProductionEvidenceShape(completeEvidence()), {
      ok: true,
      errors: [],
    });
    assert.deepEqual(validateProductionEvidenceShape(template), {
      ok: true,
      errors: [],
    });
  });
});

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function assertEvidenceObjectCovered(value, schema, path) {
  assert.ok(schema, `${path} is missing from schema`);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  for (const key of Object.keys(value)) {
    const childPath = `${path}.${key}`;
    assert.ok(
      Object.hasOwn(schema.properties ?? {}, key),
      `${childPath} is missing from schema`,
    );
    assertEvidenceObjectCovered(value[key], schema.properties[key], childPath);
  }
}

function duplicates(items = []) {
  const seen = new Set();
  const duplicateItems = new Set();

  for (const item of items) {
    if (seen.has(item)) {
      duplicateItems.add(item);
      continue;
    }
    seen.add(item);
  }

  return [...duplicateItems];
}
