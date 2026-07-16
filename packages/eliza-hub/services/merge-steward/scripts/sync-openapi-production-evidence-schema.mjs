#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const OPENAPI_URL = new URL("../openapi.json", import.meta.url);
const PRODUCTION_EVIDENCE_SCHEMA_URL = new URL(
  "../production-evidence.schema.json",
  import.meta.url,
);
const checkOnly = process.argv.includes("--check");

const [openapiText, schemaText] = await Promise.all([
  readFile(OPENAPI_URL, "utf8"),
  readFile(PRODUCTION_EVIDENCE_SCHEMA_URL, "utf8"),
]);
const openapi = JSON.parse(openapiText);
const productionEvidenceSchema = JSON.parse(schemaText);
const embeddedSchema = openapi.components?.schemas?.ProductionEvidence;

if (!embeddedSchema) {
  throw new Error("OpenAPI components.schemas.ProductionEvidence is missing");
}

if (isDeepStrictEqual(embeddedSchema, productionEvidenceSchema)) {
  console.log("OpenAPI production evidence schema is current");
  process.exit(0);
}

if (checkOnly) {
  console.error(
    "OpenAPI production evidence schema is stale; run npm run sync:openapi-schema",
  );
  process.exit(1);
}

openapi.components.schemas.ProductionEvidence = productionEvidenceSchema;
await writeFile(OPENAPI_URL, `${JSON.stringify(openapi, null, 2)}\n`);
console.log("Updated OpenAPI production evidence schema");
