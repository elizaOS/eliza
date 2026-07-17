import {
  PRODUCTION_EVIDENCE_SCHEMA,
  validateProductionEvidenceShape,
} from "./production-evidence-schema.js";
import {
  PRODUCTION_GATE_CHECKS,
  runProductionGate,
} from "./production-gate.js";
import {
  PRODUCTION_CUTOVER_PATH,
  PRODUCTION_READINESS_PATH,
} from "./production-readiness.js";

export const PRODUCTION_EVIDENCE_TEMPLATE_PATH =
  "/api/production-evidence-template";
export const PRODUCTION_EVIDENCE_TEMPLATE_FILENAME =
  "eliza-hub-production-evidence.template.json";
export const PRODUCTION_EVIDENCE_FILENAME =
  "eliza-hub-production-evidence.json";
export const PRODUCTION_EVIDENCE_INVENTORY_COMMAND =
  "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict";
export const PRODUCTION_EVIDENCE_TEMPLATE_COMMAND = `node services/merge-steward/src/cli.js production-evidence-template > "$ELIZA_ARTIFACT_ROOT/${PRODUCTION_EVIDENCE_TEMPLATE_FILENAME}"`;
export const PRODUCTION_EVIDENCE_ASSEMBLE_COMMAND =
  "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs";
export const PRODUCTION_EVIDENCE_GATE_COMMAND = `node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/${PRODUCTION_EVIDENCE_FILENAME}"`;
export const PRODUCTION_EVIDENCE_USAGE = Object.freeze({
  inventoryCommand: PRODUCTION_EVIDENCE_INVENTORY_COMMAND,
  assembleCommand: PRODUCTION_EVIDENCE_ASSEMBLE_COMMAND,
  gateCommand: PRODUCTION_EVIDENCE_GATE_COMMAND,
  note: `Fill this template only in private operator state. Do not commit live evidence, secrets, or generated ${PRODUCTION_EVIDENCE_FILENAME}.`,
});

const TEMPLATE_SCHEMA_REF =
  "../../../services/merge-steward/production-evidence.schema.json";
const HASH_PLACEHOLDER = "0".repeat(64);
const DATE_PLACEHOLDER = "1970-01-01T00:00:00.000Z";

export function buildProductionEvidenceTemplate({
  generatedAt = new Date().toISOString(),
  schema = PRODUCTION_EVIDENCE_SCHEMA,
} = {}) {
  const template = buildEvidenceObjectTemplate(schema);
  const evidenceShape = validateProductionEvidenceShape(template, { schema });
  const productionGate = runProductionGate({
    evidence: template,
    now: generatedAt ?? new Date(),
  });
  const requiredBlocks = Object.keys(template).filter(
    (key) => key !== "$schema",
  );

  return {
    schema: "https://eliza.hub/schemas/production-evidence-template.v1",
    templateVersion: 1,
    generatedAt,
    readOnly: true,
    privateEvidenceRequired: true,
    storesPrivateEvidence: false,
    templatePassesProductionGate: productionGate.ok === true,
    requiredBlocks,
    summary: {
      shapeValid: evidenceShape.ok === true,
      shapeErrors: evidenceShape.errors.length,
      gateChecks: PRODUCTION_GATE_CHECKS.length,
      gateFailures: productionGate.summary.failed,
      privateBlocksRequired: requiredBlocks.length,
    },
    gatePreview: {
      ok: productionGate.ok === true,
      checkedAt: productionGate.checkedAt,
      failedChecks: productionGate.checks
        .filter((check) => !check.ok)
        .map((check) => check.name),
      checks: productionGate.checks.map((check) => ({
        name: check.name,
        ok: check.ok === true,
        evidence: check.evidence,
        errorCount: check.errors.length,
      })),
    },
    evidenceShape: {
      ok: evidenceShape.ok === true,
      errorCount: evidenceShape.errors.length,
      errors: evidenceShape.errors,
    },
    usage: PRODUCTION_EVIDENCE_USAGE,
    links: {
      productionEvidenceTemplate: PRODUCTION_EVIDENCE_TEMPLATE_PATH,
      productionReadiness: PRODUCTION_READINESS_PATH,
      productionCutover: PRODUCTION_CUTOVER_PATH,
      productionEvidenceSchemaExport:
        "@elizaos/eliza-hub-merge-steward/production-evidence.schema.json",
      exampleTemplate:
        "deployment/hetzner-staging/release/production-evidence.example.json",
      openapi: "/openapi.json",
    },
    labels: [
      "production-evidence:template",
      "production-evidence:private-required",
      "production-evidence:non-passing",
    ],
    template,
  };
}

export function buildEvidenceObjectTemplate(
  schema = PRODUCTION_EVIDENCE_SCHEMA,
) {
  const template = buildTemplateValue(schema, []);
  if (template && typeof template === "object" && !Array.isArray(template)) {
    template.$schema = TEMPLATE_SCHEMA_REF;
  }
  return template;
}

function buildTemplateValue(schema, path) {
  if (!schema || typeof schema !== "object") return null;

  const types = normalizeTypes(schema.type);
  if (types.includes("null")) return null;
  if (types.includes("object")) return objectTemplate(schema, path);
  if (types.includes("array")) return [];
  if (types.includes("boolean")) return false;
  if (types.includes("number")) return schema.minimum ?? 0;
  if (types.includes("string")) return stringTemplate(schema, path);

  return null;
}

function objectTemplate(schema, path) {
  const output = {};
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    output[key] = buildTemplateValue(properties[key], [...path, key]);
  }
  return output;
}

function stringTemplate(schema, path) {
  const key = path[path.length - 1] ?? "";
  if (schema.enum?.length > 0) return schema.enum[0];
  if (schema.format === "date-time") return DATE_PLACEHOLDER;
  if (schema.format === "uri")
    return key === "forgejoRootUrl"
      ? "https://git.example.invalid/"
      : "https://example.invalid";
  if (schema.pattern === "^[a-f0-9]{64}$") return HASH_PLACEHOLDER;
  if (schema.pattern === "^[^\\s@]+@sha256:[a-fA-F0-9]{64}$") {
    return `registry.example.invalid/eliza/${key || "image"}@sha256:${HASH_PLACEHOLDER}`;
  }
  if (key === "forgejoDomain") return "git.example.invalid";
  if (key === "mode") return "production";
  if (key === "status") return "placeholder";
  if (key === "runId") return "placeholder-run";
  return path.join(".") || "placeholder";
}

function normalizeTypes(type) {
  if (!type) return [];
  return Array.isArray(type) ? type : [type];
}
