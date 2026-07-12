import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const PACKAGE_ROOT_URL = new URL("../", import.meta.url);
const PACKAGE_JSON_URL = new URL("package.json", PACKAGE_ROOT_URL);
const DOCKERFILE_URL = new URL("Dockerfile", PACKAGE_ROOT_URL);

describe("package entrypoint", () => {
  it("exports the steward client through the package root", async () => {
    const packageJson = await readPackageJson();
    const entrypoint = await import(
      new URL(packageJson.exports["."], PACKAGE_ROOT_URL)
    );

    assert.equal(packageJson.main, "./src/index.js");
    assert.equal(packageJson.exports["."], "./src/index.js");
    assert.equal(typeof entrypoint.createMergeStewardClient, "function");
    assert.equal(typeof entrypoint.createMergeStewardClientFromEnv, "function");
    assert.equal(typeof entrypoint.MergeStewardClient, "function");
    assert.equal(typeof entrypoint.buildAgentActionPlan, "function");
    assert.equal(typeof entrypoint.DEFAULT_AGENT_ACTION_PLAN_LIMITS, "object");
    assert.equal(typeof entrypoint.buildAgentSubmissionGate, "function");
    assert.equal(typeof entrypoint.buildAgentWorkPreflight, "function");
    assert.equal(typeof entrypoint.DEFAULT_WORK_PREFLIGHT_LIMITS, "object");
    assert.equal(typeof entrypoint.buildCiFailureAnalysis, "function");
    assert.equal(typeof entrypoint.buildValidationPlan, "function");
    assert.equal(typeof entrypoint.buildPullRequestBrief, "function");
    assert.equal(typeof entrypoint.buildReleaseNotes, "function");
    assert.equal(typeof entrypoint.buildReviewAssignment, "function");
    assert.equal(typeof entrypoint.DEFAULT_REVIEW_ASSIGNMENT_LIMITS, "object");
    assert.equal(typeof entrypoint.buildRepoSearch, "function");
    assert.equal(typeof entrypoint.DEFAULT_REPO_SEARCH_LIMITS, "object");
    assert.equal(typeof entrypoint.buildFleetCoordination, "function");
    assert.equal(entrypoint.FLEET_COORDINATION_VERSION, 1);
    assert.equal(typeof entrypoint.buildWorkContext, "function");
    assert.equal(entrypoint.WORK_CONTEXT_VERSION, 1);
    assert.equal(typeof entrypoint.buildAgentCockpit, "function");
    assert.equal(entrypoint.AGENT_COCKPIT_VERSION, 1);
    assert.equal(
      entrypoint.AGENT_COCKPIT_SCHEMA,
      "https://eliza.hub/schemas/agent-cockpit.v1",
    );
    assert.equal(typeof entrypoint.buildQueueItemActionPlan, "function");
    assert.equal(entrypoint.QUEUE_ITEM_ACTION_PLAN_VERSION, 1);
    assert.equal(
      entrypoint.QUEUE_ITEM_ACTION_PLAN_SCHEMA,
      "https://eliza.hub/schemas/queue-item-action-plan.v1",
    );
    assert.equal(typeof entrypoint.workItemId, "function");
    assert.equal(typeof entrypoint.workCycleId, "function");
    assert.equal(typeof entrypoint.workModuleId, "function");
    assert.equal(typeof entrypoint.workViewId, "function");
    assert.equal(typeof entrypoint.workPageId, "function");
    assert.equal(typeof entrypoint.normalizeWorkItem, "function");
    assert.equal(typeof entrypoint.normalizeWorkCycle, "function");
    assert.equal(typeof entrypoint.normalizeWorkModule, "function");
    assert.equal(typeof entrypoint.normalizeWorkView, "function");
    assert.equal(typeof entrypoint.normalizeWorkPage, "function");
    assert.equal(typeof entrypoint.buildWorkDashboard, "function");
    assert.equal(typeof entrypoint.buildWorkViewEvaluation, "function");
    assert.equal(typeof entrypoint.buildWorkIntakePlan, "function");
    assert.equal(typeof entrypoint.buildWorkProgress, "function");
    assert.equal(typeof entrypoint.buildMergeTrainPlan, "function");
    assert.equal(typeof entrypoint.buildPatchConflictPrediction, "function");
    assert.equal(typeof entrypoint.DEFAULT_PATCH_CONFLICT_LIMITS, "object");
    assert.equal(typeof entrypoint.buildGithubParityMatrix, "function");
    assert.equal(typeof entrypoint.applyStackDependencyEvidence, "function");
    assert.equal(typeof entrypoint.buildStackDependencyGraph, "function");
    assert.equal(entrypoint.GITHUB_PARITY_PATH, "/api/github-parity");
    assert.equal(typeof entrypoint.buildProductionReadiness, "function");
    assert.equal(
      entrypoint.PRODUCTION_READINESS_PATH,
      "/api/production-readiness",
    );
    assert.equal(typeof entrypoint.buildProductionCutoverPlan, "function");
    assert.equal(entrypoint.PRODUCTION_CUTOVER_PATH, "/api/production-cutover");
    assert.equal(typeof entrypoint.summarizeProductionReadiness, "function");
    assert.equal(typeof entrypoint.summarizeProductionCutover, "function");
    assert.equal(typeof entrypoint.buildProductionEvidenceTemplate, "function");
    assert.equal(
      entrypoint.PRODUCTION_EVIDENCE_TEMPLATE_PATH,
      "/api/production-evidence-template",
    );
    assert.equal(typeof entrypoint.PRODUCTION_EVIDENCE_SCHEMA, "object");
    assert.equal(typeof entrypoint.runProductionGate, "function");
    assert.equal(typeof entrypoint.validateProductionEvidenceShape, "function");
    assert.equal(typeof entrypoint.resolveStewardUrl, "function");
    assert.equal(
      entrypoint.resolveStewardUrl(
        "https://git.example.invalid/steward",
        "/api/agent-routing",
      ).href,
      "https://git.example.invalid/steward/api/agent-routing",
    );
  });

  it("exports the OpenAPI contract for generated clients", async () => {
    const packageJson = await readPackageJson();
    const openApiUrl = new URL(
      packageJson.exports["./openapi.json"],
      PACKAGE_ROOT_URL,
    );
    const openApi = JSON.parse(await readFile(openApiUrl, "utf8"));

    assert.equal(packageJson.exports["./openapi.json"], "./openapi.json");
    assert.equal(openApi.openapi, "3.1.0");
    assert.equal(openApi.info.title, "Eliza Merge Steward API");
  });

  it("exports the production evidence schema for release tooling", async () => {
    const packageJson = await readPackageJson();
    const schemaUrl = new URL(
      packageJson.exports["./production-evidence.schema.json"],
      PACKAGE_ROOT_URL,
    );
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));

    assert.equal(
      packageJson.exports["./production-evidence.schema.json"],
      "./production-evidence.schema.json",
    );
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(schema.title, "Eliza Hub Production Evidence");
  });

  it("ships discovery contracts in the runtime container", async () => {
    const dockerfile = await readFile(DOCKERFILE_URL, "utf8");

    assert.match(
      dockerfile,
      /COPY services\/merge-steward\/scripts \.\/scripts/,
    );
    assert.match(
      dockerfile,
      /COPY services\/merge-steward\/openapi\.json \.\/openapi\.json/,
    );
    assert.match(
      dockerfile,
      /COPY services\/merge-steward\/production-evidence\.schema\.json \.\/production-evidence\.schema\.json/,
    );
    assert.match(
      dockerfile,
      /COPY --from=verify .*\/openapi\.json \.\/openapi\.json/,
    );
    assert.match(
      dockerfile,
      /COPY --from=verify .*\/production-evidence\.schema\.json \.\/production-evidence\.schema\.json/,
    );
  });
});

async function readPackageJson() {
  return JSON.parse(await readFile(PACKAGE_JSON_URL, "utf8"));
}
