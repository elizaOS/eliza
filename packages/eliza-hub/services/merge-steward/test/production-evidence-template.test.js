import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProductionEvidenceShape } from "../src/production-evidence-schema.js";
import {
  buildEvidenceObjectTemplate,
  buildProductionEvidenceTemplate,
  PRODUCTION_EVIDENCE_TEMPLATE_PATH,
} from "../src/production-evidence-template.js";
import { runProductionGate } from "../src/production-gate.js";

describe("production evidence template", () => {
  it("builds a schema-valid template that does not pass the production gate", () => {
    const manifest = buildProductionEvidenceTemplate({
      generatedAt: "2026-07-06T00:00:00.000Z",
    });

    assert.equal(
      manifest.schema,
      "https://eliza.hub/schemas/production-evidence-template.v1",
    );
    assert.equal(manifest.templateVersion, 1);
    assert.equal(manifest.generatedAt, "2026-07-06T00:00:00.000Z");
    assert.equal(manifest.readOnly, true);
    assert.equal(manifest.privateEvidenceRequired, true);
    assert.equal(manifest.storesPrivateEvidence, false);
    assert.equal(manifest.templatePassesProductionGate, false);
    assert.equal(manifest.summary.shapeValid, true);
    assert.equal(manifest.summary.gateFailures, manifest.summary.gateChecks);
    assert.ok(manifest.requiredBlocks.includes("domain"));
    assert.ok(manifest.requiredBlocks.includes("githubMigration"));
    assert.ok(manifest.requiredBlocks.includes("mergeQueueRollout"));
    assert.ok(manifest.requiredBlocks.includes("deployment"));
    assert.equal(
      manifest.usage.inventoryCommand,
      "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
    );
    assert.equal(
      manifest.usage.assembleCommand,
      "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
    );
    assert.equal(
      manifest.usage.gateCommand,
      'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
    );
    assert.equal(
      manifest.links.productionEvidenceTemplate,
      PRODUCTION_EVIDENCE_TEMPLATE_PATH,
    );
    assert.equal(
      manifest.template.$schema,
      "../../../services/merge-steward/production-evidence.schema.json",
    );
    assert.equal(
      manifest.template.domain.forgejoRootUrl,
      "https://git.example.invalid/",
    );
    assert.equal(manifest.template.domain.probeEvidence, null);
    assert.equal(manifest.template.sso.smokeEvidence, null);
    assert.equal(manifest.template.sso.bootstrapEvidence, null);
    assert.equal(
      manifest.template.githubMigration.pilotBootstrapEvidence,
      null,
    );
    assert.equal(manifest.template.githubMigration.pilotBootstrapPassed, false);
    assert.equal(manifest.template.deployment.deployEvidence, null);
    assert.equal(manifest.template.deployment.postDeployEvidence, null);
    assert.equal(manifest.template.deployment.applied, false);
    assert.equal(manifest.template.steward.preflight.mode, "production");
    assert.equal(
      manifest.gatePreview.failedChecks.length,
      manifest.summary.gateChecks,
    );
    assert.ok(manifest.gatePreview.failedChecks.includes("sso_registration"));
    assert.ok(manifest.labels.includes("production-evidence:non-passing"));
  });

  it("keeps the raw evidence object template aligned with schema shape validation", () => {
    const template = buildEvidenceObjectTemplate();
    const shape = validateProductionEvidenceShape(template);
    const gate = runProductionGate({ evidence: template });

    assert.equal(shape.ok, true);
    assert.deepEqual(shape.errors, []);
    assert.equal(gate.ok, false);
    assert.equal(gate.evidenceShape.ok, true);
    assert.equal(gate.summary.shapeErrors, 0);
  });
});
