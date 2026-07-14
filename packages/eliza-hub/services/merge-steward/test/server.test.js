import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { checkReadiness, createServer, listen } from "../src/server.js";
import { MergeSteward } from "../src/steward.js";
import { InMemoryQueueStore } from "../src/store.js";

describe("merge steward server", () => {
  let server;
  let baseUrl;
  let store;

  before(async () => {
    process.env.MERGE_STEWARD_TEST_SECRET = WEBHOOK_SECRET;
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });
    store = new InMemoryQueueStore();
    server = createServer({
      config,
      logger: silentLogger,
      steward: new MergeSteward({ config, store, logger: silentLogger }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://${address.address}:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    delete process.env.MERGE_STEWARD_TEST_SECRET;
  });

  it("serves health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "eliza-merge-steward");
  });

  it("serves readiness with store and configuration checks", async () => {
    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "eliza-merge-steward");
    assert.equal(body.store, "memory");
    assert.equal(body.configuration.deploymentMode, "local");
    assert.equal(body.configuration.apiAuthRequired, false);
    assert.equal(body.configuration.integrationDryRun, true);
    assert.equal(body.configuration.requireWorkItemForAgentPrs, false);
    assert.equal(body.configuration.requireWorkReservationForAgentPrs, false);
    assert.equal(
      body.configuration.requireAgentBranchNamespaceForAgentPrs,
      false,
    );
    assert.equal(
      body.configuration.requireVerifiedAgentRunReceiptForAgentPrs,
      false,
    );
    assert.equal(
      body.configuration.requireAgentIdentityRegistryForAgentPrs,
      false,
    );
    assert.equal(body.configuration.knownAgentIdCount, 0);
    assert.equal(
      body.checks.find((check) => check.name === "queue_store").ok,
      true,
    );
    assert.equal(
      body.checks.find((check) => check.name === "webhook_secret")
        .secretConfigured,
      true,
    );
    assert.equal(
      body.checks.find((check) => check.name === "runtime_preflight").ok,
      true,
    );
  });

  it("reports strict work-reservation policy in readiness configuration", async () => {
    const strictConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-codex,agent-docs",
    });
    const readiness = await checkReadiness({
      config: strictConfig,
      steward: new MergeSteward({
        config: strictConfig,
        store: new InMemoryQueueStore(),
        logger: silentLogger,
      }),
    });

    assert.equal(readiness.ok, true);
    assert.equal(readiness.configuration.requireWorkItemForAgentPrs, true);
    assert.equal(
      readiness.configuration.requireWorkReservationForAgentPrs,
      true,
    );
    assert.equal(
      readiness.configuration.requireAgentBranchNamespaceForAgentPrs,
      true,
    );
    assert.equal(
      readiness.configuration.requireVerifiedAgentRunReceiptForAgentPrs,
      true,
    );
    assert.equal(
      readiness.configuration.requireAgentIdentityRegistryForAgentPrs,
      true,
    );
    assert.equal(readiness.configuration.knownAgentIdCount, 2);
  });

  it("includes persisted agent identities in readiness registry counts", async () => {
    const strictConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-seed",
    });
    const registryStore = new InMemoryQueueStore();
    await registryStore.upsertRegisteredAgent(
      { id: "agent-persisted" },
      { registeredBy: "admin-one" },
    );
    await registryStore.upsertRegisteredAgent(
      { id: "agent-disabled" },
      { registeredBy: "admin-one" },
    );
    await registryStore.disableRegisteredAgent("agent-disabled", {
      disabledBy: "admin-one",
    });

    const readiness = await checkReadiness({
      config: strictConfig,
      steward: new MergeSteward({
        config: strictConfig,
        store: registryStore,
        logger: silentLogger,
      }),
    });

    assert.equal(readiness.ok, true);
    assert.equal(readiness.configuration.knownAgentIdCount, 2);
    assert.equal(readiness.configuration.configuredAgentIdCount, 1);
    assert.equal(readiness.configuration.persistedActiveAgentIdCount, 1);
  });

  it("serves the OpenAPI contract for client discovery", async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(body.openapi, "3.1.0");
    assert.equal(body.info.title, "Eliza Merge Steward API");
    assert.ok(body.paths["/api/agent-routing"]);
    assert.ok(body.paths["/openapi.json"]);

    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
    });
    await withServer(authConfig, async (authBaseUrl) => {
      const authResponse = await fetch(`${authBaseUrl}/openapi.json`);
      const authBody = await authResponse.json();

      assert.equal(authResponse.status, 200);
      assert.equal(authBody.info.version, body.info.version);
    });
  });

  it("serves the agent discovery manifest for bootstrap clients", async () => {
    const [manifestResponse, openapiResponse] = await Promise.all([
      fetch(`${baseUrl}/.well-known/eliza-hub.json`),
      fetch(`${baseUrl}/openapi.json`),
    ]);
    const manifest = await manifestResponse.json();
    const openapi = await openapiResponse.json();

    assert.equal(manifestResponse.status, 200);
    assert.match(
      manifestResponse.headers.get("content-type"),
      /application\/json/,
    );
    assert.equal(manifest.service, "eliza-merge-steward");
    assert.equal(manifest.version, openapi.info.version);
    assert.equal(manifest.links.self, "/.well-known/eliza-hub.json");
    assert.equal(manifest.links.openapi, "/openapi.json");
    assert.equal(manifest.links.githubParity, "/api/github-parity");
    assert.equal(
      manifest.links.productionReadiness,
      "/api/production-readiness",
    );
    assert.equal(manifest.links.productionCutover, "/api/production-cutover");
    assert.equal(
      manifest.links.productionEvidenceTemplate,
      "/api/production-evidence-template",
    );
    assert.equal(manifest.links.agentRouting, "/api/agent-routing");
    assert.equal(manifest.links.queueSimulation, "/api/queue/simulate");
    assert.equal(manifest.links.releaseReadiness, "/api/release-readiness");
    assert.equal(
      manifest.links.repositoryProtection,
      "/api/repository-protection",
    );
    assert.equal(manifest.links.ciValidationPlan, "/api/ci/validation-plan");
    assert.equal(manifest.links.agentIdentities, "/api/agent-identities");
    assert.equal(
      manifest.links.agentBootstrapTemplate,
      "/api/agents/{agentId}/bootstrap",
    );
    assert.equal(
      manifest.links.claimNextTemplate,
      "/api/agents/{agentId}/claim-next",
    );
    assert.equal(manifest.auth.requiredForApiRoutes, false);
    assert.ok(manifest.capabilities.includes("agent_routing"));
    assert.ok(manifest.capabilities.includes("agent_bootstrap"));
    assert.ok(manifest.capabilities.includes("queue_simulation"));
    assert.ok(manifest.capabilities.includes("release_readiness"));
    assert.ok(manifest.capabilities.includes("repository_protection"));
    assert.ok(manifest.capabilities.includes("claim_transfer"));
    assert.ok(manifest.capabilities.includes("ci_validation_plan"));
    assert.ok(manifest.capabilities.includes("github_parity_matrix"));
    assert.ok(manifest.capabilities.includes("production_readiness_checklist"));
    assert.ok(manifest.capabilities.includes("production_cutover_plan"));
    assert.ok(manifest.capabilities.includes("production_evidence_inventory"));
    assert.ok(manifest.capabilities.includes("production_evidence_template"));
    assert.equal(
      manifest.githubParity.status,
      "forgejo_plus_eliza_not_full_github_parity",
    );
    assert.equal(manifest.githubParity.githubDropInReplacement, false);
    assert.ok(
      manifest.githubParity.migrationGuardrailIds.includes(
        "not_drop_in_github",
      ),
    );
    assert.ok(
      manifest.githubParity.agentNativeAdditionIds.includes("agent_cockpit"),
    );
    assert.equal(
      manifest.productionReadiness.status,
      "blocked_until_private_evidence_passes",
    );
    assert.equal(manifest.productionReadiness.privateEvidenceRequired, true);
    assert.equal(manifest.clientHints.mergeExecution.integrationEnabled, false);
    assert.equal(manifest.clientHints.mergeExecution.integrationDryRun, true);
    assert.equal(
      manifest.clientHints.mergeExecution.liveIntegrationActive,
      false,
    );
    assert.equal(
      manifest.clientHints.mergeExecution.liveAgentMergesEvidenceGated,
      true,
    );
    assert.equal(
      manifest.clientHints.mergeExecution
        .liveAgentMergesAllowedWithoutProductionEvidence,
      false,
    );
    assert.equal(
      manifest.clientHints.mergeExecution.productionCutoverRequired,
      true,
    );
    assert.equal(
      manifest.clientHints.productionEvidence.artifactRootEnv,
      "ELIZA_ARTIFACT_ROOT",
    );
    assert.match(
      manifest.clientHints.productionEvidence.commands.inventory,
      /production-evidence-inventory\.mjs --strict/,
    );
    assert.equal(
      manifest.clientHints.productionEvidence.inventoryMustPassBeforeAssemble,
      true,
    );
    assert.equal(manifest.surfaces.projectBoard.authority, "eliza_computed");
    assert.equal(
      manifest.surfaces.discussions.status,
      "not_supported_as_native_discussions",
    );

    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
    });
    await withServer(authConfig, async (authBaseUrl) => {
      const authResponse = await fetch(
        `${authBaseUrl}/.well-known/eliza-hub.json`,
      );
      const authManifest = await authResponse.json();

      assert.equal(authResponse.status, 200);
      assert.equal(authManifest.auth.requiredForApiRoutes, true);
      assert.equal(authManifest.clientHints.apiRoutesUseBearerAuth, true);
    });
  });

  it("serves the GitHub parity matrix for Eliza Cloud and agent clients", async () => {
    const response = await fetch(`${baseUrl}/api/github-parity`);
    const body = await response.json();
    const surfaces = Object.fromEntries(
      body.parity.surfaces.map((surface) => [surface.id, surface]),
    );

    assert.equal(response.status, 200);
    assert.equal(
      body.parity.status,
      "forgejo_plus_eliza_not_full_github_parity",
    );
    assert.equal(
      body.parity.summary.githubParityClaim,
      "explicit_partial_parity",
    );
    assert.equal(surfaces.git_repositories.status, "native");
    assert.equal(surfaces.projects_v2.status, "eliza_computed");
    assert.equal(surfaces.merge_queue.status, "eliza_steward");
    assert.equal(surfaces.discussions.status, "not_supported");
    assert.ok(
      body.parity.agentNativeAdditions.some(
        (surface) => surface.id === "agent_routing",
      ),
    );
  });

  it("serves the production readiness checklist for Eliza Cloud and agent clients", async () => {
    const response = await fetch(`${baseUrl}/api/production-readiness`);
    const body = await response.json();
    const domains = Object.fromEntries(
      body.productionReadiness.domains.map((domain) => [domain.id, domain]),
    );

    assert.equal(response.status, 200);
    assert.equal(
      body.productionReadiness.status,
      "blocked_until_private_evidence_passes",
    );
    assert.equal(body.productionReadiness.currentUse, "demo_ready");
    assert.equal(body.productionReadiness.productionReady, false);
    assert.equal(body.productionReadiness.privateEvidenceRequired, true);
    assert.equal(body.productionReadiness.privateEvidenceEvaluated, false);
    assert.equal(
      body.productionReadiness.authoritativeGate.missingChecklistEntries.length,
      0,
    );
    assert.equal(domains.domain_tls.status, "blocked");
    assert.equal(domains.domain_tls.gateCheck, null);
    assert.equal(domains.sso_registration.evidenceBlock, "sso");
    assert.equal(
      domains.merge_queue_rollout.evidenceBlock,
      "mergeQueueRollout",
    );
    assert.ok(
      body.productionReadiness.nextActions.some(
        (action) => action.id === "repository_protection",
      ),
    );
  });

  it("serves the production cutover plan for Eliza Cloud and operators", async () => {
    const response = await fetch(`${baseUrl}/api/production-cutover`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.productionCutover.readOnly, true);
    assert.equal(body.productionCutover.status, "blocked");
    assert.equal(body.productionCutover.productionReady, false);
    assert.equal(body.productionCutover.privateEvidenceRequired, true);
    assert.equal(
      body.productionCutover.guardrails.liveAgentMergesAllowed,
      false,
    );
    assert.equal(body.productionCutover.nextPhase.id, "foundation");
    assert.ok(
      body.productionCutover.phases.some(
        (phase) => phase.id === "steward_and_merge_queue",
      ),
    );
    assert.ok(
      body.productionCutover.executionPlan.orderedSteps.some(
        (step) => step.domainId === "runner_isolation",
      ),
    );
    assert.equal(
      body.productionCutover.links.productionReadiness,
      "/api/production-readiness",
    );
  });

  it("serves the production evidence template for private cutover assembly", async () => {
    const response = await fetch(`${baseUrl}/api/production-evidence-template`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.productionEvidenceTemplate.readOnly, true);
    assert.equal(body.productionEvidenceTemplate.privateEvidenceRequired, true);
    assert.equal(body.productionEvidenceTemplate.storesPrivateEvidence, false);
    assert.equal(
      body.productionEvidenceTemplate.templatePassesProductionGate,
      false,
    );
    assert.equal(body.productionEvidenceTemplate.summary.shapeValid, true);
    assert.ok(body.productionEvidenceTemplate.requiredBlocks.includes("sso"));
    assert.equal(
      body.productionEvidenceTemplate.usage.inventoryCommand,
      "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
    );
    assert.equal(
      body.productionEvidenceTemplate.usage.assembleCommand,
      "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
    );
    assert.equal(
      body.productionEvidenceTemplate.template.sso.smokeEvidence,
      null,
    );
    assert.equal(
      body.productionEvidenceTemplate.template.sso.bootstrapEvidence,
      null,
    );
    assert.equal(
      body.productionEvidenceTemplate.links.productionCutover,
      "/api/production-cutover",
    );
  });

  it("serves an agent bootstrap snapshot with identity policy links and claims", async () => {
    const bootstrapConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-one",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
    });

    await withServer(
      bootstrapConfig,
      async (bootstrapBaseUrl, bootstrapStore) => {
        await bootstrapStore.upsertRegisteredAgent(
          { id: "agent-one", source: "test" },
          { registeredBy: "admin-one" },
        );
        await bootstrapStore.upsertQueueItem(
          readyItem({
            pullRequestId: 771,
            ownerAgentId: "agent-one",
            queueState: "ready",
          }),
        );
        await bootstrapStore.claimAgentWork(
          agentClaim({
            ownerAgentId: "agent-one",
            resourceId: "packages/core",
            resourceKind: "package",
          }),
          {
            now: "2026-07-07T00:00:00.000Z",
            ttlMs: 60_000,
          },
        );

        const response = await fetch(
          `${bootstrapBaseUrl}/api/agents/agent-one/bootstrap?repo=elizaos%2Feliza&targetBranch=develop&readiness=false&now=2026-07-07T00%3A00%3A00.000Z`,
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.bootstrap.agentId, "agent-one");
        assert.equal(body.bootstrap.identity.state, "known");
        assert.equal(
          body.bootstrap.identity.registrySummary.knownAgentIdCount,
          1,
        );
        assert.equal(
          body.bootstrap.policyHints.agentBranchNamespace.expectedPrefix,
          "agent/agent-one/",
        );
        assert.equal(body.bootstrap.policyHints.workReservation.required, true);
        assert.equal(
          body.bootstrap.policyHints.submissionGate.maxQueuedWork,
          4,
        );
        assert.equal(
          body.bootstrap.policyHints.submissionGate.maxRecentSubmissions,
          3,
        );
        assert.equal(
          body.bootstrap.links.inbox,
          "/api/agents/agent-one/inbox?repo=elizaos%2Feliza&targetBranch=develop&readiness=false",
        );
        assert.equal(
          body.bootstrap.links.workReservation,
          "/api/agents/agent-one/work-reservation",
        );
        assert.equal(body.bootstrap.snapshots.claims.counts.active, 1);
        assert.equal(
          Array.isArray(body.bootstrap.snapshots.inbox.cardIds),
          true,
        );
        assert.ok(
          body.bootstrap.nextActions.some(
            (action) => action.id === "preflight_before_branch",
          ),
        );
      },
    );
  });

  it("serves an agent action plan that composes search, preflight, validation, submission, conflict, and review checks", async () => {
    const actionPlanConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-action,agent-reviewer",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
    });

    await withServer(
      actionPlanConfig,
      async (actionPlanBaseUrl, actionPlanStore) => {
        await actionPlanStore.upsertRegisteredAgent(
          {
            id: "agent-action",
            source: "test",
          },
          { registeredBy: "admin-one" },
        );
        await actionPlanStore.upsertRegisteredAgent(
          {
            id: "agent-reviewer",
            source: "test",
            metadata: {
              reviewPackages: ["plugin-capacitor-bridge"],
              reviewPaths: ["packages/plugin-capacitor-bridge/**"],
            },
          },
          { registeredBy: "admin-one" },
        );
        await actionPlanStore.claimAgentWork(
          {
            repo: "elizaos/eliza",
            resourceKind: "path",
            resourceId: "packages/plugin-capacitor-bridge/src/index.ts",
            ownerAgentId: "agent-action",
            paths: ["packages/plugin-capacitor-bridge/src/index.ts"],
            metadata: { packages: ["plugin-capacitor-bridge"] },
          },
          {
            now: "2026-07-07T00:00:00.000Z",
            ttlMs: 60 * 60 * 1000,
          },
        );

        const response = await fetch(
          `${actionPlanBaseUrl}/api/agents/agent-action/action-plan`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              now: "2026-07-07T00:00:00.000Z",
              readiness: false,
              query: "capacitor bridge typecheck",
              commands: ["turbo run typecheck"],
              proposedItem: {
                repo: "elizaos/eliza",
                targetBranch: "develop",
                sourceBranch: "agent/agent-action/capacitor-typecheck",
                ownerAgentId: "agent-action",
                authorKind: "agent",
                agentKnown: true,
                hasIssueLink: true,
                hasExecutionPlan: true,
                hasValidationPlan: true,
                changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
                affectedPackages: ["plugin-capacitor-bridge"],
              },
              documents: [
                {
                  kind: "actions_log",
                  id: "log-action-plan",
                  repo: "elizaos/eliza",
                  targetBranch: "develop",
                  ownerAgentId: "agent-action",
                  title: "capacitor bridge typecheck failed",
                  body: "tsc failed in packages/plugin-capacitor-bridge/src/index.ts",
                },
              ],
            }),
          },
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.actionPlan.readOnly, true);
        assert.equal(body.actionPlan.agentId, "agent-action");
        assert.equal(body.actionPlan.mode, "proposed_work");
        assert.equal(body.actionPlan.decision.state, "blocked");
        assert.equal(body.actionPlan.decision.canStart, true);
        assert.equal(body.actionPlan.decision.canSubmit, false);
        assert.ok(
          body.actionPlan.decision.blockers.includes(
            "broad_validation_commands",
          ),
        );
        assert.equal(
          body.actionPlan.checks.find((check) => check.id === "agent_identity")
            .status,
          "pass",
        );
        assert.equal(
          body.actionPlan.checks.find((check) => check.id === "work_preflight")
            .status,
          "warn",
        );
        assert.equal(
          body.actionPlan.checks.find(
            (check) => check.id === "validation_budget",
          ).status,
          "fail",
        );
        assert.equal(
          body.actionPlan.checks.find(
            (check) => check.id === "patch_conflict_prediction",
          ).status,
          "warn",
        );
        assert.equal(
          body.actionPlan.checks.find(
            (check) => check.id === "review_assignment",
          ).status,
          "pass",
        );
        assert.equal(
          body.actionPlan.context.search.results[0].kind,
          "actions_log",
        );
        assert.equal(
          body.actionPlan.context.validationPlan.recommendedCommands[0].command,
          "turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge",
        );
        assert.equal(
          body.actionPlan.context.reviewAssignment.suggestedReviewers[0]
            .agentId,
          "agent-reviewer",
        );
        assert.ok(
          body.actionPlan.labels.includes(
            "agent-action-plan:validation_budget:fail",
          ),
        );
      },
    );
  });

  it("reports worker lease readiness when the worker is enabled", async () => {
    process.env.MERGE_STEWARD_TEST_FORGEJO_TOKEN = "local-forgejo-token";
    const workerConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      FORGEJO_TOKEN_ENV: "MERGE_STEWARD_TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_WORKER_ENABLED: "true",
      MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "true",
    });
    const workerStore = new InMemoryQueueStore();
    await workerStore.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-a" },
      { now: "2026-07-06T00:00:00.000Z", ttlMs: 30000 },
    );

    try {
      const readiness = await checkReadiness({
        config: workerConfig,
        steward: new MergeSteward({
          config: workerConfig,
          store: workerStore,
          logger: silentLogger,
        }),
      });
      const leaseCheck = readiness.checks.find(
        (check) => check.name === "worker_lease",
      );

      assert.equal(readiness.ok, true);
      assert.equal(readiness.configuration.workerEnabled, true);
      assert.equal(readiness.configuration.workerLeaseEnabled, true);
      assert.equal(leaseCheck.ok, true);
      assert.equal(leaseCheck.leaseId, "merge-queue");
      assert.equal(leaseCheck.ownerId, "worker-a");
      assert.equal(leaseCheck.expiresAt, "2026-07-06T00:00:30.000Z");
    } finally {
      delete process.env.MERGE_STEWARD_TEST_FORGEJO_TOKEN;
    }
  });

  it("serves Prometheus metrics", async () => {
    const metricsConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(metricsConfig, async (metricsBaseUrl, metricsStore) => {
      await metricsStore.upsertQueueItem(
        readyItem({ pullRequestId: 51, queueState: "ready" }),
      );
      const response = await fetch(`${metricsBaseUrl}/metrics`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/plain/);
      assert.match(body, /# HELP eliza_merge_steward_info/);
      assert.match(body, /eliza_merge_steward_ready 1/);
      assert.match(body, /eliza_merge_steward_queue_items\{state="ready"\}/);
    });
  });

  it("requires metrics auth when configured", async () => {
    process.env.MERGE_STEWARD_TEST_API_TOKEN = "metrics-token";
    const metricsConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_TEST_API_TOKEN",
      MERGE_STEWARD_METRICS_AUTH_REQUIRED: "true",
    });

    try {
      await withServer(metricsConfig, async (metricsBaseUrl) => {
        const missing = await fetch(`${metricsBaseUrl}/metrics`);
        assert.equal(missing.status, 401);

        const allowed = await fetch(`${metricsBaseUrl}/metrics`, {
          headers: { authorization: "Bearer metrics-token" },
        });
        const body = await allowed.text();

        assert.equal(allowed.status, 200);
        assert.match(body, /eliza_merge_steward_ready 1/);
      });
    } finally {
      delete process.env.MERGE_STEWARD_TEST_API_TOKEN;
    }
  });

  it("reports readiness failures for required API auth without a token", async () => {
    delete process.env.MERGE_STEWARD_MISSING_API_TOKEN;
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
    });

    await withServer(authConfig, async (authBaseUrl) => {
      const response = await fetch(`${authBaseUrl}/ready`);
      const body = await response.json();
      const authCheck = body.checks.find(
        (check) => check.name === "control_api_auth",
      );

      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(authCheck.ok, false);
      assert.equal(authCheck.required, true);
      assert.equal(authCheck.tokenConfigured, false);
    });
  });

  it("reports readiness failures when the queue store is unavailable", async () => {
    const readyConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });
    const failingServer = createServer({
      config: readyConfig,
      logger: silentLogger,
      steward: {
        async listQueue() {
          throw new Error("database unavailable");
        },
      },
    });

    await new Promise((resolve) =>
      failingServer.listen(0, "127.0.0.1", resolve),
    );
    const address = failingServer.address();
    const failingBaseUrl = `http://${address.address}:${address.port}`;

    try {
      const response = await fetch(`${failingBaseUrl}/ready`);
      const body = await response.json();
      const storeCheck = body.checks.find(
        (check) => check.name === "queue_store",
      );

      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(storeCheck.ok, false);
      assert.equal(storeCheck.error, "database unavailable");
    } finally {
      await new Promise((resolve, reject) => {
        failingServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refuses to listen with unsafe production configuration", () => {
    const productionConfig = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
    });

    assert.throws(
      () => listen({ config: productionConfig, logger: silentLogger }),
      /merge_steward_preflight_failed/,
    );
  });

  it("requires bearer auth for API endpoints when configured", async () => {
    process.env.MERGE_STEWARD_TEST_API_TOKEN = "local-api-token";
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_TEST_API_TOKEN",
    });

    try {
      await withServer(authConfig, async (authBaseUrl) => {
        const missing = await fetch(`${authBaseUrl}/api/queue`);
        assert.equal(missing.status, 401);
        assert.equal(missing.headers.get("www-authenticate"), "Bearer");

        const wrong = await fetch(`${authBaseUrl}/api/queue`, {
          headers: { authorization: "Bearer wrong-token" },
        });
        assert.equal(wrong.status, 401);

        const allowed = await fetch(`${authBaseUrl}/api/queue`, {
          headers: { authorization: "Bearer local-api-token" },
        });
        const allowedBody = await allowed.json();
        assert.equal(allowed.status, 200);
        assert.deepEqual(allowedBody.items, []);
      });
    } finally {
      delete process.env.MERGE_STEWARD_TEST_API_TOKEN;
    }
  });

  it("reports API auth misconfiguration when the required token is absent", async () => {
    delete process.env.MERGE_STEWARD_MISSING_API_TOKEN;
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
    });

    await withServer(authConfig, async (authBaseUrl) => {
      const response = await fetch(`${authBaseUrl}/api/queue`);
      const body = await response.json();

      assert.equal(response.status, 503);
      assert.equal(body.error, "api_auth_token_unconfigured");
    });
  });

  it("accepts OIDC bearer tokens for API endpoints when enabled", async () => {
    delete process.env.MERGE_STEWARD_MISSING_API_TOKEN;
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_AUDIENCE: "eliza-merge-steward",
    });
    const authVerifier = {
      async verify(token) {
        if (token !== "valid-eliza-cloud-jwt") {
          throw new Error("invalid token");
        }
        return {
          subject: "user-one",
          payload: { sub: "user-one", roles: ["steward"] },
        };
      },
    };

    await withServer(
      authConfig,
      async (authBaseUrl) => {
        const missing = await fetch(`${authBaseUrl}/api/queue`);
        assert.equal(missing.status, 401);

        const wrong = await fetch(`${authBaseUrl}/api/queue`, {
          headers: { authorization: "Bearer wrong-token" },
        });
        assert.equal(wrong.status, 401);

        const allowed = await fetch(`${authBaseUrl}/api/queue`, {
          headers: { authorization: "Bearer valid-eliza-cloud-jwt" },
        });
        const allowedBody = await allowed.json();
        assert.equal(allowed.status, 200);
        assert.deepEqual(allowedBody.items, []);
      },
      { authVerifier },
    );
  });

  it("binds OIDC agent identity to mutating claim endpoints", async () => {
    delete process.env.MERGE_STEWARD_MISSING_API_TOKEN;
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      MERGE_STEWARD_OIDC_ADMIN_ROLES: "steward-admin",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_AUDIENCE: "eliza-merge-steward",
    });
    const authVerifier = oidcVerifierFor({
      "agent-one-token": {
        subject: "agent-one-subject",
        payload: {
          sub: "agent-one-subject",
          agent_id: "agent-one",
          preferred_username: "agent-one",
        },
      },
      "agent-two-token": {
        subject: "agent-two-subject",
        payload: {
          sub: "agent-two-subject",
          agent_id: "agent-two",
          preferred_username: "agent-two",
        },
      },
      "admin-token": {
        subject: "admin-subject",
        payload: {
          sub: "admin-subject",
          roles: ["steward-admin"],
          preferred_username: "admin-user",
        },
      },
    });

    await withServer(
      authConfig,
      async (authBaseUrl) => {
        const spoofClaimResponse = await fetch(`${authBaseUrl}/api/claims`, {
          method: "POST",
          headers: oidcJsonHeaders("agent-one-token"),
          body: JSON.stringify({
            claim: agentClaim({ ownerAgentId: "agent-two" }),
          }),
        });
        const claimResponse = await fetch(`${authBaseUrl}/api/claims`, {
          method: "POST",
          headers: oidcJsonHeaders("agent-one-token"),
          body: JSON.stringify({
            claim: agentClaim({ ownerAgentId: "agent-one" }),
          }),
        });
        const claimBody = await claimResponse.json();
        const crossRenewResponse = await fetch(
          `${authBaseUrl}/api/claims/renew`,
          {
            method: "POST",
            headers: oidcJsonHeaders("agent-two-token"),
            body: JSON.stringify({
              id: claimBody.claim.id,
              ownerAgentId: "agent-one",
            }),
          },
        );
        const inferredRenewResponse = await fetch(
          `${authBaseUrl}/api/claims/renew`,
          {
            method: "POST",
            headers: oidcJsonHeaders("agent-one-token"),
            body: JSON.stringify({
              id: claimBody.claim.id,
              now: "2026-07-06T00:01:00.000Z",
            }),
          },
        );
        const transferResponse = await fetch(
          `${authBaseUrl}/api/claims/transfer`,
          {
            method: "POST",
            headers: oidcJsonHeaders("agent-one-token"),
            body: JSON.stringify({
              id: claimBody.claim.id,
              fromOwnerAgentId: "agent-one",
              toOwnerAgentId: "agent-two",
              reason: "handoff",
            }),
          },
        );
        const transferBody = await transferResponse.json();
        const crossTransferResponse = await fetch(
          `${authBaseUrl}/api/claims/transfer`,
          {
            method: "POST",
            headers: oidcJsonHeaders("agent-one-token"),
            body: JSON.stringify({
              id: claimBody.claim.id,
              fromOwnerAgentId: "agent-two",
              toOwnerAgentId: "agent-three",
            }),
          },
        );
        const routeMismatchResponse = await fetch(
          `${authBaseUrl}/api/agents/agent-two/claim-next`,
          {
            method: "POST",
            headers: oidcJsonHeaders("agent-one-token"),
            body: JSON.stringify({ repo: "elizaos/eliza" }),
          },
        );
        const reservationRouteMismatchResponse = await fetch(
          `${authBaseUrl}/api/agents/agent-two/work-reservation`,
          {
            method: "POST",
            headers: oidcJsonHeaders("agent-one-token"),
            body: JSON.stringify({
              repo: "elizaos/eliza",
              changedFiles: ["packages/core/src/runtime.ts"],
            }),
          },
        );

        assert.equal(spoofClaimResponse.status, 403);
        assert.equal(
          (await spoofClaimResponse.json()).error,
          "agent_identity_mismatch",
        );
        assert.equal(claimResponse.status, 200);
        assert.equal(claimBody.claim.ownerAgentId, "agent-one");
        assert.equal(crossRenewResponse.status, 403);
        assert.equal(
          (await crossRenewResponse.json()).error,
          "agent_identity_mismatch",
        );
        assert.equal(inferredRenewResponse.status, 200);
        assert.equal(transferResponse.status, 200);
        assert.equal(transferBody.claim.ownerAgentId, "agent-two");
        assert.equal(crossTransferResponse.status, 403);
        assert.equal(
          (await crossTransferResponse.json()).error,
          "agent_identity_mismatch",
        );
        assert.equal(routeMismatchResponse.status, 403);
        assert.equal(reservationRouteMismatchResponse.status, 403);
      },
      { authVerifier },
    );
  });

  it("rejects unregistered OIDC agent ids when strict identity registry is enabled", async () => {
    delete process.env.MERGE_STEWARD_MISSING_API_TOKEN;
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-one",
    });
    const authVerifier = oidcVerifierFor({
      "agent-one-token": {
        subject: "agent-one-subject",
        payload: {
          sub: "agent-one-subject",
          agent_id: "agent-one",
          preferred_username: "agent-one",
        },
      },
      "agent-two-token": {
        subject: "agent-two-subject",
        payload: {
          sub: "agent-two-subject",
          agent_id: "agent-two",
          preferred_username: "agent-two",
        },
      },
    });

    await withServer(
      authConfig,
      async (authBaseUrl) => {
        const allowedResponse = await fetch(`${authBaseUrl}/api/claims`, {
          method: "POST",
          headers: oidcJsonHeaders("agent-one-token"),
          body: JSON.stringify({
            claim: agentClaim({ ownerAgentId: "agent-one" }),
          }),
        });
        const allowedBody = await allowedResponse.json();
        const blockedResponse = await fetch(`${authBaseUrl}/api/claims`, {
          method: "POST",
          headers: oidcJsonHeaders("agent-two-token"),
          body: JSON.stringify({
            claim: agentClaim({ ownerAgentId: "agent-two" }),
          }),
        });
        const blockedTransferResponse = await fetch(
          `${authBaseUrl}/api/claims/transfer`,
          {
            method: "POST",
            headers: oidcJsonHeaders("agent-one-token"),
            body: JSON.stringify({
              id: allowedBody.claim.id,
              fromOwnerAgentId: "agent-one",
              toOwnerAgentId: "agent-two",
            }),
          },
        );

        assert.equal(allowedResponse.status, 200);
        assert.equal(blockedResponse.status, 403);
        assert.equal(
          (await blockedResponse.json()).error,
          "agent_identity_unregistered",
        );
        assert.equal(blockedTransferResponse.status, 403);
        assert.equal(
          (await blockedTransferResponse.json()).error,
          "agent_identity_unregistered",
        );
      },
      { authVerifier },
    );
  });

  it("lets operators manage registered agent identities and uses them for strict agent auth", async () => {
    process.env.MERGE_STEWARD_TEST_API_TOKEN = "registry-secret";
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_TEST_API_TOKEN",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-seed",
    });

    try {
      await withServer(authConfig, async (authBaseUrl) => {
        const registerResponse = await fetch(
          `${authBaseUrl}/api/agent-identities`,
          {
            method: "POST",
            headers: jsonHeaders("registry-secret"),
            body: JSON.stringify({
              agentId: "agent-persisted",
              displayName: "Persisted Agent",
              source: "eliza-cloud",
              registeredBy: "admin-one",
            }),
          },
        );
        const registerBody = await registerResponse.json();
        const listResponse = await fetch(
          `${authBaseUrl}/api/agent-identities?status=active`,
          {
            headers: authHeaders("registry-secret"),
          },
        );
        const listBody = await listResponse.json();
        const claimResponse = await fetch(`${authBaseUrl}/api/claims`, {
          method: "POST",
          headers: jsonHeaders("registry-secret"),
          body: JSON.stringify({
            claim: agentClaim({ ownerAgentId: "agent-persisted" }),
          }),
        });
        const disableResponse = await fetch(
          `${authBaseUrl}/api/agent-identities/disable`,
          {
            method: "POST",
            headers: jsonHeaders("registry-secret"),
            body: JSON.stringify({
              id: "agent-persisted",
              reason: "rotated",
              disabledBy: "admin-one",
            }),
          },
        );
        const blockedClaimResponse = await fetch(`${authBaseUrl}/api/claims`, {
          method: "POST",
          headers: jsonHeaders("registry-secret"),
          body: JSON.stringify({
            claim: agentClaim({
              ownerAgentId: "agent-persisted",
              resourceId: "src/other.ts",
            }),
          }),
        });

        assert.equal(registerResponse.status, 200);
        assert.equal(registerBody.agent.id, "agent-persisted");
        assert.equal(registerBody.agent.registeredBy, "admin-one");
        assert.equal(registerBody.summary.knownAgentIdCount, 2);
        assert.equal(listResponse.status, 200);
        assert.equal(listBody.agents.length, 1);
        assert.equal(listBody.summary.persistedActiveAgentIdCount, 1);
        assert.equal(claimResponse.status, 200);
        assert.equal(disableResponse.status, 200);
        assert.equal(blockedClaimResponse.status, 403);
        assert.equal(
          (await blockedClaimResponse.json()).error,
          "agent_identity_unregistered",
        );
      });
    } finally {
      delete process.env.MERGE_STEWARD_TEST_API_TOKEN;
    }
  });

  it("requires OIDC admin identity to mutate the agent identity registry", async () => {
    delete process.env.MERGE_STEWARD_MISSING_API_TOKEN;
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_OIDC_ADMIN_ROLES: "steward-admin",
    });
    const authVerifier = oidcVerifierFor({
      "agent-token": {
        subject: "agent-one",
        payload: { sub: "agent-one", agent_id: "agent-one", roles: ["agent"] },
      },
      "admin-token": {
        subject: "admin-one",
        payload: {
          sub: "admin-one",
          preferred_username: "admin-one",
          roles: ["steward-admin"],
        },
      },
    });

    await withServer(
      authConfig,
      async (authBaseUrl) => {
        const blockedResponse = await fetch(
          `${authBaseUrl}/api/agent-identities`,
          {
            method: "POST",
            headers: oidcJsonHeaders("agent-token"),
            body: JSON.stringify({ agentId: "agent-one" }),
          },
        );
        const allowedResponse = await fetch(
          `${authBaseUrl}/api/agent-identities`,
          {
            method: "POST",
            headers: oidcJsonHeaders("admin-token"),
            body: JSON.stringify({ agentId: "agent-one" }),
          },
        );
        const allowedBody = await allowedResponse.json();

        assert.equal(blockedResponse.status, 403);
        assert.equal(
          (await blockedResponse.json()).error,
          "agent_identity_registry_admin_required",
        );
        assert.equal(allowedResponse.status, 200);
        assert.equal(allowedBody.agent.id, "agent-one");
        assert.equal(allowedBody.agent.registeredBy, "admin-one");
      },
      { authVerifier },
    );
  });

  it("binds OIDC actor identity to approvals and policy overrides", async () => {
    delete process.env.MERGE_STEWARD_MISSING_API_TOKEN;
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_MISSING_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_AUDIENCE: "eliza-merge-steward",
    });
    const authVerifier = oidcVerifierFor({
      "operator-token": {
        subject: "user-one",
        payload: {
          sub: "user-one",
          preferred_username: "operator-one",
          email: "operator@example.invalid",
        },
      },
    });

    await withServer(
      authConfig,
      async (authBaseUrl, authStore) => {
        const spoofRequestResponse = await fetch(
          `${authBaseUrl}/api/approvals`,
          {
            method: "POST",
            headers: oidcJsonHeaders("operator-token"),
            body: JSON.stringify({
              runId: "run-missing",
              nodeId: "security_review",
              requestedBy: "spoofed-user",
            }),
          },
        );
        await fetch(`${authBaseUrl}/api/runs`, {
          method: "POST",
          headers: oidcJsonHeaders("operator-token"),
          body: JSON.stringify({
            id: "run-oidc-approval",
            queueItemId: "elizaos/eliza#601",
            status: "waiting_approval",
          }),
        });
        const requestResponse = await fetch(`${authBaseUrl}/api/approvals`, {
          method: "POST",
          headers: oidcJsonHeaders("operator-token"),
          body: JSON.stringify({
            runId: "run-oidc-approval",
            nodeId: "security_review",
            allowedActors: ["operator-one"],
          }),
        });
        const requestBody = await requestResponse.json();
        const blockedActorResponse = await fetch(
          `${authBaseUrl}/api/approvals/decide`,
          {
            method: "POST",
            headers: oidcJsonHeaders("operator-token"),
            body: JSON.stringify({
              id: requestBody.approval.id,
              approved: true,
              decidedBy: "operator@example.invalid",
            }),
          },
        );
        const spoofDecisionResponse = await fetch(
          `${authBaseUrl}/api/approvals/decide`,
          {
            method: "POST",
            headers: oidcJsonHeaders("operator-token"),
            body: JSON.stringify({
              id: requestBody.approval.id,
              approved: true,
              decidedBy: "spoofed-user",
            }),
          },
        );
        const inferredDecisionResponse = await fetch(
          `${authBaseUrl}/api/approvals/decide`,
          {
            method: "POST",
            headers: oidcJsonHeaders("operator-token"),
            body: JSON.stringify({
              id: requestBody.approval.id,
              approved: true,
            }),
          },
        );
        const inferredDecisionBody = await inferredDecisionResponse.json();

        await authStore.upsertQueueItem(
          readyItem({
            repo: "elizaos/cloud",
            pullRequestId: 602,
            hasExecutionPlan: false,
          }),
        );
        const spoofOverrideResponse = await fetch(
          `${authBaseUrl}/api/queue/item/override`,
          {
            method: "POST",
            headers: oidcJsonHeaders("operator-token"),
            body: JSON.stringify({
              id: "elizaos/cloud#602",
              approvedBy: "spoofed-user",
              reason: "spoofed",
            }),
          },
        );
        const inferredOverrideResponse = await fetch(
          `${authBaseUrl}/api/queue/item/override`,
          {
            method: "POST",
            headers: oidcJsonHeaders("operator-token"),
            body: JSON.stringify({
              id: "elizaos/cloud#602",
              reason: "approved by authenticated actor",
            }),
          },
        );
        const inferredOverrideBody = await inferredOverrideResponse.json();

        assert.equal(spoofRequestResponse.status, 403);
        assert.equal(
          (await spoofRequestResponse.json()).error,
          "actor_identity_mismatch",
        );
        assert.equal(requestResponse.status, 200);
        assert.equal(requestBody.approval.requestedBy, "operator-one");
        assert.equal(blockedActorResponse.status, 403);
        assert.equal(
          (await blockedActorResponse.json()).error,
          "approval_actor_not_allowed",
        );
        assert.equal(spoofDecisionResponse.status, 403);
        assert.equal(
          (await spoofDecisionResponse.json()).error,
          "actor_identity_mismatch",
        );
        assert.equal(inferredDecisionResponse.status, 200);
        assert.equal(inferredDecisionBody.approval.decidedBy, "operator-one");
        assert.equal(spoofOverrideResponse.status, 403);
        assert.equal(
          (await spoofOverrideResponse.json()).error,
          "actor_identity_mismatch",
        );
        assert.equal(inferredOverrideResponse.status, 200);
        assert.equal(
          inferredOverrideBody.item.policyOverride.approvedBy,
          "operator-one",
        );
      },
      { authVerifier },
    );
  });

  it("keeps signed Forgejo webhooks on the HMAC auth path", async () => {
    process.env.MERGE_STEWARD_TEST_API_TOKEN = "local-api-token";
    const authConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_TEST_API_TOKEN",
    });

    try {
      await withServer(authConfig, async (authBaseUrl) => {
        const rawBody = JSON.stringify(pullRequestPayload({ number: 31 }));
        const response = await fetch(`${authBaseUrl}/api/webhooks/forgejo`, {
          method: "POST",
          headers: signedHeaders(rawBody, {
            "content-type": "application/json",
            "x-forgejo-delivery": "delivery-pr-31",
            "x-forgejo-event": "pull_request",
          }),
          body: rawBody,
        });
        const body = await response.json();

        assert.equal(response.status, 202);
        assert.equal(body.accepted, true);
        assert.equal(body.item.id, "elizaos/eliza#31");
      });
    } finally {
      delete process.env.MERGE_STEWARD_TEST_API_TOKEN;
    }
  });

  it("rejects oversized request bodies before buffering arbitrary input", async () => {
    const bodyLimitConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_MAX_BODY_BYTES: "16",
    });

    await withServer(bodyLimitConfig, async (limitedBaseUrl) => {
      const response = await fetch(`${limitedBaseUrl}/api/comments/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          item: { title: "this body is intentionally too large" },
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 413);
      assert.equal(body.error, "bad_request");
      assert.equal(body.message, "request_body_too_large");
    });
  });

  it("evaluates a queue item", async () => {
    const response = await fetch(`${baseUrl}/api/queue/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        item: {
          authorKind: "human",
          targetProtected: true,
          reviewSatisfied: true,
          headShaMatches: true,
          changedFiles: ["README.md"],
          requiredChecks: ["smoke"],
          checkResults: { smoke: "success" },
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.decision.allowed, true);
  });

  it("schedules allowed items and filters blocked items", async () => {
    const response = await fetch(`${baseUrl}/api/queue/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            pullRequestId: 1,
            authorKind: "human",
            priority: 1,
            targetProtected: true,
            reviewSatisfied: true,
            headShaMatches: true,
            changedFiles: ["README.md"],
            requiredChecks: ["smoke"],
            checkResults: { smoke: "success" },
          },
          {
            pullRequestId: 2,
            authorKind: "agent",
            agentKnown: false,
            targetProtected: true,
            reviewSatisfied: true,
            headShaMatches: true,
            changedFiles: ["README.md"],
            requiredChecks: ["smoke"],
            checkResults: { smoke: "success" },
          },
        ],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.queue.length, 1);
    assert.equal(body.queue[0].pullRequestId, 1);
  });

  it("simulates proposed queue items without mutating stored queue state", async () => {
    const simulationConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      simulationConfig,
      async (simulationBaseUrl, simulationStore) => {
        await simulationStore.upsertQueueItem(
          readyItem({
            id: "elizaos/eliza#31",
            pullRequestId: 31,
            priority: 5,
            queueState: "ready",
          }),
        );

        const response = await fetch(
          `${simulationBaseUrl}/api/queue/simulate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              proposedItem: readyItem({
                pullRequestId: 32,
                priority: 20,
                sourceBranch: "agent/agent-one/simulated-change",
                changedFiles: ["packages/core/src/simulation.ts"],
                affectedPackages: ["core"],
              }),
            }),
          },
        );
        const body = await response.json();
        const storedItems = await simulationStore.listQueueItems();

        assert.equal(response.status, 200);
        assert.equal(body.simulation.readOnly, true);
        assert.equal(body.simulation.baseline.counts.items, 1);
        assert.equal(body.simulation.simulated.counts.items, 2);
        assert.equal(body.simulation.proposed[0].pullRequestId, 32);
        assert.equal(
          body.simulation.proposed[0].outcome,
          "selected_for_integration",
        );
        assert.equal(body.simulation.proposed[0].queuePosition, 1);
        assert.equal(
          body.simulation.impact.displacedItems[0].pullRequestId,
          31,
        );
        assert.equal(storedItems.length, 1);
        assert.equal(storedItems[0].pullRequestId, 31);
      },
    );
  });

  it("builds an integration plan for queue items", async () => {
    const response = await fetch(`${baseUrl}/api/queue/integration-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            repo: "elizaos/eliza",
            pullRequestId: 21,
            sourceBranch: "agent/change",
            targetBranch: "develop",
            headSha: "head-sha-21",
            authorKind: "agent",
            ownerAgentId: "agent-one",
            agentKnown: true,
            hasIssueLink: true,
            hasExecutionPlan: true,
            hasValidationPlan: true,
            targetProtected: true,
            reviewSatisfied: true,
            headShaMatches: true,
            changedFiles: ["README.md"],
            requiredChecks: ["smoke"],
            checkResults: { smoke: "success" },
          },
        ],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.planCount, 1);
    assert.equal(
      body.plans[0].integrationBranch,
      "eliza-queue/develop/elizaos-eliza-pr-21",
    );
    assert.equal(
      body.plans[0].actions.at(-1).type,
      "merge_original_pull_request",
    );
  });

  it("keeps integration execution disabled by default", async () => {
    const response = await fetch(`${baseUrl}/api/queue/integration-execution`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        items: [
          {
            repo: "elizaos/eliza",
            pullRequestId: 22,
            sourceBranch: "agent/change",
            targetBranch: "develop",
            headSha: "head-sha-22",
            authorKind: "agent",
            ownerAgentId: "agent-one",
            agentKnown: true,
            hasIssueLink: true,
            hasExecutionPlan: true,
            hasValidationPlan: true,
            targetProtected: true,
            reviewSatisfied: true,
            headShaMatches: true,
            changedFiles: ["README.md"],
            requiredChecks: ["smoke"],
            checkResults: { smoke: "success" },
          },
        ],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.plan.planCount, 1);
    assert.equal(body.execution.enabled, false);
    assert.equal(body.execution.reason, "integration_disabled");
  });

  it("serves approval request and decision endpoints", async () => {
    const approvalConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(approvalConfig, async (approvalBaseUrl) => {
      const requestResponse = await fetch(`${approvalBaseUrl}/api/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "elizaos/eliza#301",
          request: { reason: "sensitive paths" },
          allowedActors: ["maintainer-one"],
        }),
      });
      const requestBody = await requestResponse.json();
      const listRequestedResponse = await fetch(
        `${approvalBaseUrl}/api/approvals?status=requested`,
      );
      const listRequestedBody = await listRequestedResponse.json();
      const decideResponse = await fetch(
        `${approvalBaseUrl}/api/approvals/decide`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: requestBody.approval.id,
            approved: true,
            decidedBy: "maintainer-one",
            note: "approved",
          }),
        },
      );
      const decideBody = await decideResponse.json();
      const listApprovedResponse = await fetch(
        `${approvalBaseUrl}/api/approvals?status=approved`,
      );
      const listApprovedBody = await listApprovedResponse.json();

      assert.equal(requestResponse.status, 200);
      assert.equal(
        requestBody.approval.id,
        "elizaos/eliza#301:human_approval:0",
      );
      assert.equal(listRequestedBody.approvals.length, 1);
      assert.equal(decideResponse.status, 200);
      assert.equal(decideBody.approval.status, "approved");
      assert.equal(decideBody.approval.decidedBy, "maintainer-one");
      assert.equal(listApprovedResponse.status, 200);
      assert.equal(listApprovedBody.approvals.length, 1);
    });
  });

  it("applies run-scoped approval requests and decisions to run state", async () => {
    const approvalConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(approvalConfig, async (approvalBaseUrl) => {
      await fetch(`${approvalBaseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "run-approval-one",
          queueItemId: "elizaos/eliza#401",
          status: "running",
        }),
      });
      const missingRunResponse = await fetch(
        `${approvalBaseUrl}/api/approvals`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: "missing-run",
            request: { reason: "missing" },
          }),
        },
      );
      const requestResponse = await fetch(`${approvalBaseUrl}/api/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-approval-one",
          nodeId: "security_review",
          request: { reason: "sensitive paths" },
          allowedActors: ["maintainer-one"],
        }),
      });
      const requestBody = await requestResponse.json();
      const waitingStateResponse = await fetch(
        `${approvalBaseUrl}/api/runs/run-approval-one/run-state`,
      );
      const waitingStateBody = await waitingStateResponse.json();
      const approveResponse = await fetch(
        `${approvalBaseUrl}/api/approvals/decide`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: requestBody.approval.id,
            approved: true,
            decidedBy: "maintainer-one",
          }),
        },
      );
      const runningStateResponse = await fetch(
        `${approvalBaseUrl}/api/runs/run-approval-one/run-state`,
      );
      const runningStateBody = await runningStateResponse.json();
      const nodesResponse = await fetch(
        `${approvalBaseUrl}/api/runs/run-approval-one/nodes`,
      );
      const nodesBody = await nodesResponse.json();
      const eventsResponse = await fetch(
        `${approvalBaseUrl}/api/runs/run-approval-one/events`,
      );
      const eventsBody = await eventsResponse.json();

      await fetch(`${approvalBaseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "run-approval-denied",
          queueItemId: "elizaos/eliza#402",
          status: "running",
        }),
      });
      const deniedRequestResponse = await fetch(
        `${approvalBaseUrl}/api/approvals`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: "run-approval-denied",
            nodeId: "release_approval",
          }),
        },
      );
      const deniedRequestBody = await deniedRequestResponse.json();
      await fetch(`${approvalBaseUrl}/api/approvals/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: deniedRequestBody.approval.id,
          approved: false,
          decidedBy: "maintainer-one",
        }),
      });
      const deniedStateResponse = await fetch(
        `${approvalBaseUrl}/api/runs/run-approval-denied/run-state`,
      );
      const deniedStateBody = await deniedStateResponse.json();

      assert.equal(missingRunResponse.status, 404);
      assert.equal(requestResponse.status, 200);
      assert.equal(
        requestBody.approval.id,
        "run-approval-one:security_review:0",
      );
      assert.equal(waitingStateBody.runState.state, "waiting-approval");
      assert.equal(waitingStateBody.runState.blocked.nodeId, "security_review");
      assert.equal(approveResponse.status, 200);
      assert.equal(runningStateBody.runState.state, "running");
      assert.equal(nodesBody.nodes[0].status, "succeeded");
      assert.equal(
        nodesBody.nodes[0].completedByApprovalId,
        requestBody.approval.id,
      );
      assert.equal(
        eventsBody.events.map((event) => event.type).join(","),
        "ApprovalRequested,ApprovalDecided",
      );
      assert.equal(deniedStateBody.runState.state, "failed");
    });
  });

  it("serves human request lifecycle endpoints", async () => {
    const runConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(runConfig, async (runBaseUrl) => {
      const createRunResponse = await fetch(`${runBaseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "run-human-one",
          queueItemId: "elizaos/eliza#501",
          status: "waiting_approval",
        }),
      });
      const missingRunResponse = await fetch(
        `${runBaseUrl}/api/human-requests`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: "missing-run", prompt: "approve?" }),
        },
      );
      const requestResponse = await fetch(`${runBaseUrl}/api/human-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-human-one",
          nodeId: "security_review",
          kind: "confirm",
          prompt: "Approve sensitive path change?",
        }),
      });
      const requestBody = await requestResponse.json();
      const itemResponse = await fetch(
        `${runBaseUrl}/api/human-requests/item?id=${encodeURIComponent(requestBody.request.id)}`,
      );
      const respondResponse = await fetch(
        `${runBaseUrl}/api/human-requests/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: requestBody.request.id,
            response: { approved: true },
            respondedBy: "operator-one",
          }),
        },
      );
      const respondBody = await respondResponse.json();
      const listResponse = await fetch(
        `${runBaseUrl}/api/human-requests?status=answered&runId=run-human-one`,
      );
      const listBody = await listResponse.json();

      assert.equal(createRunResponse.status, 200);
      assert.equal(missingRunResponse.status, 404);
      assert.equal(requestResponse.status, 200);
      assert.equal(
        requestBody.request.id,
        "human:run-human-one:security_review:0",
      );
      assert.equal(itemResponse.status, 200);
      assert.equal(respondResponse.status, 200);
      assert.equal(respondBody.request.response.approved, true);
      assert.equal(listResponse.status, 200);
      assert.equal(listBody.requests.length, 1);
    });
  });

  it("serves signal receive and consume endpoints", async () => {
    const signalConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(signalConfig, async (signalBaseUrl) => {
      const createResponse = await fetch(`${signalBaseUrl}/api/signals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          correlationKey: "checks:abc123",
          type: "checks.passed",
          payload: { sha: "abc123" },
        }),
      });
      const createBody = await createResponse.json();
      const consumeResponse = await fetch(
        `${signalBaseUrl}/api/signals/consume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: createBody.signal.id,
            consumerId: "merge-steward",
          }),
        },
      );
      const consumeBody = await consumeResponse.json();
      const listResponse = await fetch(
        `${signalBaseUrl}/api/signals?correlationKey=checks%3Aabc123&status=consumed`,
      );
      const listBody = await listResponse.json();

      assert.equal(createResponse.status, 200);
      assert.equal(createBody.signal.status, "received");
      assert.equal(consumeResponse.status, 200);
      assert.equal(consumeBody.signal.status, "consumed");
      assert.equal(listResponse.status, 200);
      assert.equal(listBody.signals.length, 1);
    });
  });

  it("serves agent claim lease endpoints", async () => {
    const claimConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(claimConfig, async (claimBaseUrl) => {
      const claimResponse = await fetch(`${claimBaseUrl}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim: agentClaim(),
          ttlMs: 60_000,
          now: "2026-07-06T00:00:00.000Z",
        }),
      });
      const claimBody = await claimResponse.json();
      const conflictResponse = await fetch(`${claimBaseUrl}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim: agentClaim({ ownerAgentId: "agent-two" }),
          ttlMs: 60_000,
          now: "2026-07-06T00:00:30.000Z",
        }),
      });
      const conflictBody = await conflictResponse.json();
      const renewResponse = await fetch(`${claimBaseUrl}/api/claims/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: claimBody.claim.id,
          ownerAgentId: "agent-one",
          ttlMs: 120_000,
          now: "2026-07-06T00:00:45.000Z",
        }),
      });
      const renewBody = await renewResponse.json();
      const listResponse = await fetch(
        `${claimBaseUrl}/api/claims?ownerAgentId=agent-one&status=active`,
      );
      const listBody = await listResponse.json();
      const itemResponse = await fetch(
        `${claimBaseUrl}/api/claims/item?id=${encodeURIComponent(claimBody.claim.id)}`,
      );
      const itemBody = await itemResponse.json();
      const transferMismatchResponse = await fetch(
        `${claimBaseUrl}/api/claims/transfer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: claimBody.claim.id,
            fromOwnerAgentId: "agent-two",
            toOwnerAgentId: "agent-three",
            now: "2026-07-06T00:00:50.000Z",
          }),
        },
      );
      const transferResponse = await fetch(
        `${claimBaseUrl}/api/claims/transfer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: claimBody.claim.id,
            fromOwnerAgentId: "agent-one",
            toOwnerAgentId: "agent-two",
            reason: "handoff",
            ttlMs: 90_000,
            now: "2026-07-06T00:00:55.000Z",
          }),
        },
      );
      const transferBody = await transferResponse.json();
      const releaseResponse = await fetch(
        `${claimBaseUrl}/api/claims/release`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: claimBody.claim.id,
            ownerAgentId: "agent-two",
            reason: "done",
            now: "2026-07-06T00:01:00.000Z",
          }),
        },
      );
      const releaseBody = await releaseResponse.json();

      assert.equal(claimResponse.status, 200);
      assert.equal(claimBody.claimed, true);
      assert.equal(claimBody.claim.id, "claim:elizaos/eliza:path:src/core.ts");
      assert.equal(conflictResponse.status, 409);
      assert.equal(conflictBody.reason, "already_claimed");
      assert.equal(renewResponse.status, 200);
      assert.equal(renewBody.claim.expiresAt, "2026-07-06T00:02:45.000Z");
      assert.equal(listBody.claims.length, 1);
      assert.equal(itemBody.claim.ownerAgentId, "agent-one");
      assert.equal(transferMismatchResponse.status, 404);
      assert.equal(transferResponse.status, 200);
      assert.equal(transferBody.claim.ownerAgentId, "agent-two");
      assert.equal(transferBody.claim.expiresAt, "2026-07-06T00:02:25.000Z");
      assert.equal(
        transferBody.claim.metadata.transferredFromAgentId,
        "agent-one",
      );
      assert.equal(
        transferBody.claim.metadata.transferredToAgentId,
        "agent-two",
      );
      assert.equal(transferBody.claim.metadata.transferReason, "handoff");
      assert.deepEqual(transferBody.claim.metadata.handoffs, [
        {
          fromAgentId: "agent-one",
          toAgentId: "agent-two",
          reason: "handoff",
          transferredAt: "2026-07-06T00:00:55.000Z",
        },
      ]);
      assert.equal(releaseResponse.status, 200);
      assert.equal(releaseBody.claim.status, "released");
      assert.equal(releaseBody.claim.releaseReason, "done");
    });
  });

  it("lets an agent claim the next routed work item", async () => {
    const claimNextConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      claimNextConfig,
      async (claimNextBaseUrl, claimNextStore) => {
        await claimNextStore.upsertQueueItem(
          readyItem({
            pullRequestId: 751,
            queueState: "waiting_for_review",
            priority: 50,
            ownerAgentId: "agent-claim-next",
            reviewSatisfied: false,
            changedFiles: ["packages/client/src/chat.ts"],
          }),
        );
        await claimNextStore.upsertQueueItem(
          readyItem({
            pullRequestId: 752,
            queueState: "ready",
            priority: 10,
            ownerAgentId: "agent-claim-next",
            requiredChecks: ["unit"],
            checkResults: { unit: "failure" },
            changedFiles: ["packages/core/src/runtime.ts"],
          }),
        );

        const dryRunResponse = await fetch(
          `${claimNextBaseUrl}/api/agents/agent-claim-next/claim-next`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              now: "2026-07-06T00:10:00.000Z",
              dryRun: true,
            }),
          },
        );
        const dryRunBody = await dryRunResponse.json();

        const claimResponse = await fetch(
          `${claimNextBaseUrl}/api/agents/agent-claim-next/claim-next`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              ttlMs: 60_000,
              now: "2026-07-06T00:10:00.000Z",
            }),
          },
        );
        const claimBody = await claimResponse.json();
        const listResponse = await fetch(
          `${claimNextBaseUrl}/api/claims?ownerAgentId=agent-claim-next&status=active`,
        );
        const listBody = await listResponse.json();

        assert.equal(dryRunResponse.status, 200);
        assert.equal(dryRunBody.dryRun, true);
        assert.equal(dryRunBody.candidate.pullRequestId, 752);
        assert.equal(dryRunBody.claim.resourceKind, "pull_request");
        assert.equal(claimResponse.status, 200);
        assert.equal(claimBody.claimed, true);
        assert.equal(claimBody.candidate.action, "route_failed_checks");
        assert.equal(claimBody.claim.resourceKind, "pull_request");
        assert.equal(claimBody.claim.resourceId, "752");
        assert.deepEqual(claimBody.claim.paths, [
          "packages/core/src/runtime.ts",
        ]);
        assert.equal(claimBody.claim.expiresAt, "2026-07-06T00:11:00.000Z");
        assert.equal(listBody.claims.length, 1);
        assert.equal(listBody.claims[0].metadata.action, "route_failed_checks");
      },
    );
  });

  it("serves repository policy endpoints", async () => {
    const policyConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(policyConfig, async (policyBaseUrl) => {
      const createResponse = await fetch(`${policyBaseUrl}/api/repo-policies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            repo: "elizaos/eliza",
            queueMode: "batched",
            protectedBranches: ["main"],
            requiredChecks: ["test", "lint"],
            trustedActors: ["operator-one", "agent-one"],
            allowForks: true,
            policy: { maxBatchSize: 4 },
          },
        }),
      });
      const createBody = await createResponse.json();
      const listResponse = await fetch(`${policyBaseUrl}/api/repo-policies`);
      const listBody = await listResponse.json();
      const itemResponse = await fetch(
        `${policyBaseUrl}/api/repo-policies/item?repo=${encodeURIComponent("elizaos/eliza")}`,
      );
      const itemBody = await itemResponse.json();
      const missingResponse = await fetch(
        `${policyBaseUrl}/api/repo-policies/item?repo=${encodeURIComponent("elizaos/runtime")}`,
      );
      const missingBody = await missingResponse.json();
      const blockedScheduleResponse = await fetch(
        `${policyBaseUrl}/api/queue/schedule`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: [
              readyItem({
                targetBranch: "main",
                targetProtected: false,
                requiredChecks: ["test"],
                checkResults: { test: "success" },
              }),
            ],
          }),
        },
      );
      const blockedScheduleBody = await blockedScheduleResponse.json();
      const allowedScheduleResponse = await fetch(
        `${policyBaseUrl}/api/queue/schedule`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: [
              readyItem({
                targetBranch: "main",
                targetProtected: false,
                requiredChecks: ["test"],
                checkResults: { test: "success", lint: "success" },
              }),
            ],
          }),
        },
      );
      const allowedScheduleBody = await allowedScheduleResponse.json();

      assert.equal(createResponse.status, 200);
      assert.equal(createBody.policy.repo, "elizaos/eliza");
      assert.equal(createBody.policy.queueMode, "batched");
      assert.deepEqual(createBody.policy.requiredChecks, ["test", "lint"]);
      assert.equal(createBody.policy.policy.maxBatchSize, 4);
      assert.equal(listResponse.status, 200);
      assert.equal(listBody.policies.length, 1);
      assert.equal(itemResponse.status, 200);
      assert.equal(itemBody.policy.allowForks, true);
      assert.equal(missingResponse.status, 404);
      assert.equal(missingBody.error, "repo_policy_not_found");
      assert.equal(blockedScheduleResponse.status, 200);
      assert.equal(blockedScheduleBody.queue.length, 0);
      assert.equal(allowedScheduleResponse.status, 200);
      assert.equal(allowedScheduleBody.queue.length, 1);
      assert.deepEqual(allowedScheduleBody.queue[0].requiredChecks, [
        "test",
        "lint",
      ]);
      assert.equal(allowedScheduleBody.queue[0].targetProtected, true);
    });
  });

  it("serves repository protection audits for Eliza Cloud merge gates", async () => {
    const protectionConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      protectionConfig,
      async (protectionBaseUrl, protectionStore) => {
        await protectionStore.upsertRepoPolicy({
          repo: "elizaos/eliza",
          queueMode: "serialized",
          protectedBranches: ["develop"],
          requiredChecks: ["test", "lint"],
          trustedActors: ["agent-one"],
          allowForks: false,
        });

        const response = await fetch(
          `${protectionBaseUrl}/api/repository-protection?repo=elizaos/eliza&targetBranch=develop&requireLive=false&now=2026-07-06T00:10:00.000Z`,
        );
        const body = await response.json();
        const missingResponse = await fetch(
          `${protectionBaseUrl}/api/repository-protection`,
        );
        const missingBody = await missingResponse.json();

        assert.equal(response.status, 200);
        assert.equal(body.repositoryProtection.repo, "elizaos/eliza");
        assert.equal(body.repositoryProtection.targetBranch, "develop");
        assert.equal(body.repositoryProtection.status, "watch");
        assert.equal(body.repositoryProtection.productionReady, false);
        assert.ok(
          body.repositoryProtection.labels.includes("repo-protection:watch"),
        );
        assert.equal(
          body.repositoryProtection.checks.find(
            (check) => check.name === "repo_policy_present",
          ).status,
          "pass",
        );
        assert.equal(
          body.repositoryProtection.checks.find(
            (check) => check.name === "live_branch_protection_verified",
          ).status,
          "warn",
        );
        assert.ok(
          body.repositoryProtection.requiredActions.includes(
            "verify_live_branch_protection_before_cutover",
          ),
        );
        assert.equal(missingResponse.status, 400);
        assert.equal(missingBody.error, "missing_repo");
      },
    );
  });

  it("serves an agent coordination summary", async () => {
    const coordinationConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(coordinationConfig, async (coordinationBaseUrl) => {
      await fetch(`${coordinationBaseUrl}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim: agentClaim({
            ownerAgentId: "agent-one",
            resourceId: "src/core.ts",
            paths: ["src/core.ts"],
          }),
          ttlMs: 30 * 60 * 1000,
          now: "2026-07-06T00:00:00.000Z",
        }),
      });
      await fetch(`${coordinationBaseUrl}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim: agentClaim({
            ownerAgentId: "agent-two",
            resourceId: "src/old.ts",
            paths: ["src/old.ts"],
          }),
          ttlMs: 60_000,
          now: "2026-07-06T00:00:00.000Z",
        }),
      });
      await fetch(`${coordinationBaseUrl}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim: agentClaim({
            ownerAgentId: "agent-two",
            resourceKind: "runner",
            resourceId: "ci-capacity",
            paths: [],
          }),
          ttlMs: 30 * 60 * 1000,
          now: "2026-07-06T00:00:00.000Z",
        }),
      });
      await fetch(`${coordinationBaseUrl}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim: agentClaim({
            ownerAgentId: "agent-one",
            resourceKind: "environment",
            resourceId: "staging",
            paths: [],
          }),
          ttlMs: 60_000,
          now: "2026-07-06T00:00:00.000Z",
        }),
      });
      await fetch(`${coordinationBaseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "run-agent-one",
          queueItemId: "elizaos/eliza#701",
          ownerKind: "agent",
          ownerId: "agent-one",
          status: "running",
        }),
      });

      const response = await fetch(
        `${coordinationBaseUrl}/api/coordination?now=2026-07-06T00:10:00.000Z`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.summary.claims.active, 2);
      assert.equal(body.summary.claims.stale, 2);
      assert.equal(body.summary.runs.running, 1);
      assert.equal(
        body.summary.agents.find((agent) => agent.agentId === "agent-one")
          .activeClaims,
        1,
      );
      assert.equal(
        body.summary.agents.find((agent) => agent.agentId === "agent-two")
          .staleClaims,
        1,
      );
      assert.equal(body.summary.hotPaths[0].path, "src/core.ts");

      const contractResponse = await fetch(
        `${coordinationBaseUrl}/api/fleet-coordination?repo=elizaos%2Feliza&ownerAgentId=agent-one&now=2026-07-06T00%3A10%3A00.000Z`,
      );
      const contractBody = await contractResponse.json();
      const runnerLever = contractBody.coordinationContract.sharedLevers.find(
        (lever) => lever.id === "runner_capacity",
      );
      const stagingLever = contractBody.coordinationContract.sharedLevers.find(
        (lever) => lever.id === "staging_environment",
      );

      assert.equal(contractResponse.status, 200);
      assert.equal(
        contractBody.coordinationContract.claimProtocol.blockedAfterMinutes,
        30,
      );
      assert.equal(runnerLever.state, "claimed_by_other");
      assert.equal(runnerLever.activeClaim.ownerAgentId, "agent-two");
      assert.equal(stagingLever.state, "own_claim_stale");
      assert.ok(
        contractBody.coordinationContract.nextActions.some(
          (action) => action.id === "coordinate_shared_lever_claims",
        ),
      );
    });
  });

  it("serves a workflow cockpit view for Eliza Cloud dashboards", async () => {
    const workflowConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(workflowConfig, async (workflowBaseUrl, workflowStore) => {
      await workflowStore.upsertQueueItem(
        readyItem({
          pullRequestId: 801,
          queueState: "waiting_for_review",
          priority: 7,
          changedFiles: ["src/core.ts"],
        }),
      );
      await workflowStore.upsertRun({
        id: "run-workflow-one",
        queueItemId: "elizaos/eliza#801",
        repo: "elizaos/eliza",
        pullRequestId: 801,
        ownerKind: "agent",
        ownerId: "agent-one",
        status: "waiting_approval",
      });
      await workflowStore.upsertApproval({
        id: "approval-workflow-one",
        runId: "run-workflow-one",
        queueItemId: "elizaos/eliza#801",
        nodeId: "security_review",
        status: "requested",
      });
      await workflowStore.upsertHumanRequest({
        id: "human-workflow-one",
        runId: "run-workflow-one",
        status: "waiting_input",
        prompt: "Confirm release scope.",
      });
      await workflowStore.claimAgentWork(
        agentClaim({
          resourceId: "src/core.ts",
          paths: ["src/core.ts"],
          expiresAt: "2026-07-06T00:20:00.000Z",
        }),
        { now: "2026-07-06T00:00:00.000Z" },
      );

      const response = await fetch(
        `${workflowBaseUrl}/api/workflows?now=2026-07-06T00:10:00.000Z`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.workflow.readiness.ok, true);
      assert.equal(body.workflow.counts.cards, 1);
      assert.equal(body.workflow.counts.openApprovals, 1);
      assert.equal(body.workflow.counts.openHumanRequests, 1);
      assert.equal(
        body.workflow.inbox.approvals[0].id,
        "approval-workflow-one",
      );
      assert.equal(body.workflow.cards[0].id, "queue:elizaos/eliza#801");
      assert.equal(body.workflow.cards[0].status, "needs-human");
      assert.equal(body.workflow.cards[0].claims[0].resourceId, "src/core.ts");
      assert.deepEqual(body.workflow.cards[0].nextActions.slice(0, 2), [
        "decide_approval",
        "answer_human_request",
      ]);
    });
  });

  it("serves workflow operations with scoped merge train preflight state", async () => {
    const workflowConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
    });

    await withServer(workflowConfig, async (workflowBaseUrl, workflowStore) => {
      await workflowStore.upsertQueueItem(
        readyItem({
          pullRequestId: 805,
          queueState: "ready",
          priority: 8,
        }),
      );
      await workflowStore.upsertQueueItem(
        readyItem({
          pullRequestId: 806,
          targetBranch: "main",
          queueState: "ready",
          priority: 10,
        }),
      );

      const response = await fetch(
        `${workflowBaseUrl}/api/workflows?repo=elizaos/eliza&targetBranch=develop&now=2026-07-06T00:10:00.000Z`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body.workflow.filters, {
        repo: "elizaos/eliza",
        targetBranch: "develop",
        ownerAgentId: null,
      });
      assert.equal(body.workflow.counts.queueItems, 1);
      assert.equal(body.workflow.operations.status, "dry_run_ready");
      assert.equal(body.workflow.operations.controlPlane.status, "ready");
      assert.equal(body.workflow.operations.actions.status, "dry_run_ready");
      assert.equal(body.workflow.operations.runner.status, "dry_run_only");
      assert.equal(body.workflow.operations.mergeQueue.status, "dry_run_ready");
      assert.deepEqual(body.workflow.operations.mergeQueue.selectedItemIds, [
        "elizaos/eliza#805",
      ]);
      assert.ok(
        body.workflow.operations.nextActions.includes("review_dry_run_train"),
      );
    });
  });

  it("serves an Eliza project board for agent work", async () => {
    const boardConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(boardConfig, async (boardBaseUrl, boardStore) => {
      await boardStore.upsertQueueItem(
        readyItem({
          pullRequestId: 811,
          queueState: "ready",
          priority: 8,
          ownerAgentId: "agent-board-one",
          changedFiles: ["src/ready.ts"],
        }),
      );
      await boardStore.upsertQueueItem(
        readyItem({
          pullRequestId: 812,
          queueState: "blocked_conflict",
          priority: 9,
          ownerAgentId: "agent-board-two",
          pullRequestMergeable: false,
          changedFiles: ["src/blocked.ts"],
        }),
      );
      await boardStore.upsertRun({
        id: "run-board-one",
        queueItemId: "elizaos/eliza#812",
        repo: "elizaos/eliza",
        pullRequestId: 812,
        ownerKind: "agent",
        ownerId: "agent-board-two",
        status: "failed",
      });
      await boardStore.claimAgentWork(
        agentClaim({
          ownerAgentId: "agent-board-one",
          resourceId: "src/ready.ts",
          paths: ["src/ready.ts"],
          expiresAt: "2026-07-06T00:20:00.000Z",
        }),
        { now: "2026-07-06T00:00:00.000Z" },
      );

      const response = await fetch(
        `${boardBaseUrl}/api/project-board?repo=elizaos/eliza&now=2026-07-06T00:10:00.000Z&emptyColumns=false`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.board.filters.repo, "elizaos/eliza");
      assert.equal(body.board.readiness.ok, true);
      assert.equal(body.board.counts.cards, 2);
      assert.equal(body.board.counts.ready, 1);
      assert.equal(body.board.counts.failed, 1);
      assert.deepEqual(
        body.board.columns.map((column) => column.id),
        ["failed", "ready"],
      );
      assert.equal(
        body.board.columns.find((column) => column.id === "ready").cards[0]
          .claims[0].resourceId,
        "src/ready.ts",
      );
      assert.equal(body.board.mergeQueue.lanes[0].state, "needs-attention");
      assert.ok(
        body.board.mergeQueue.lanes[0].batchCandidateCardIds.includes(
          "queue:elizaos/eliza#811",
        ),
      );
    });
  });

  it("serves an agent inbox for owned Eliza work", async () => {
    const inboxConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(inboxConfig, async (inboxBaseUrl, inboxStore) => {
      await inboxStore.upsertQueueItem(
        readyItem({
          pullRequestId: 821,
          queueState: "ready",
          ownerAgentId: "agent-inbox-one",
          changedFiles: ["src/inbox-ready.ts"],
        }),
      );
      await inboxStore.upsertQueueItem(
        readyItem({
          pullRequestId: 822,
          queueState: "waiting_for_review",
          priority: 9,
          ownerAgentId: "agent-inbox-one",
          changedFiles: ["src/inbox-review.ts"],
        }),
      );
      await inboxStore.upsertQueueItem(
        readyItem({
          pullRequestId: 823,
          queueState: "ready",
          ownerAgentId: "agent-inbox-two",
          changedFiles: ["src/other-agent.ts"],
        }),
      );
      await inboxStore.upsertRun({
        id: "run-inbox-one",
        queueItemId: "elizaos/eliza#822",
        repo: "elizaos/eliza",
        pullRequestId: 822,
        ownerKind: "agent",
        ownerId: "agent-inbox-one",
        status: "waiting_approval",
      });
      await inboxStore.upsertApproval({
        id: "approval-inbox-one",
        runId: "run-inbox-one",
        queueItemId: "elizaos/eliza#822",
        status: "requested",
      });
      await inboxStore.claimAgentWork(
        agentClaim({
          ownerAgentId: "agent-inbox-one",
          resourceId: "src/inbox-ready.ts",
          paths: ["src/inbox-ready.ts"],
          expiresAt: "2026-07-06T00:20:00.000Z",
        }),
        { now: "2026-07-06T00:00:00.000Z" },
      );

      const response = await fetch(
        `${inboxBaseUrl}/api/agents/agent-inbox-one/inbox?repo=elizaos/eliza&now=2026-07-06T00:10:00.000Z`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.inbox.agentId, "agent-inbox-one");
      assert.equal(body.inbox.filters.repo, "elizaos/eliza");
      assert.equal(body.inbox.readiness.ok, true);
      assert.equal(body.inbox.counts.cards, 2);
      assert.equal(body.inbox.counts.needsHuman, 1);
      assert.equal(body.inbox.counts.ready, 1);
      assert.equal(body.inbox.counts.activeClaims, 1);
      assert.equal(body.inbox.nextActions[0].action, "decide_approval");
      assert.equal(
        body.inbox.cards.some(
          (card) => card.ownerAgentId === "agent-inbox-two",
        ),
        false,
      );
      assert.equal(body.inbox.mergeQueue.lanes[0].state, "needs-attention");
    });
  });

  it("serves an agent work context resume packet", async () => {
    const contextConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(contextConfig, async (contextBaseUrl, contextStore) => {
      await contextStore.upsertQueueItem(
        readyItem({
          pullRequestId: 824,
          queueState: "waiting_for_review",
          ownerAgentId: "agent-context-one",
          changedFiles: ["docs/context.md"],
          affectedPackages: ["docs"],
        }),
      );
      await contextStore.upsertWorkItem(
        {
          repo: "elizaos/eliza",
          taskId: "context-docs",
          title: "Document agent context",
          kind: "task",
          state: "in_progress",
          ownerAgentId: "agent-context-one",
          paths: ["docs/context.md"],
          packages: ["docs"],
        },
        { actorId: "agent-context-one", now: "2026-07-06T00:00:00.000Z" },
      );
      await contextStore.upsertWorkPage(
        {
          repo: "elizaos/eliza",
          title: "Agent context plan",
          kind: "agent_plan",
          state: "active",
          ownerAgentId: "agent-context-one",
          taskId: "context-docs",
          body: "Resume from the context endpoint.",
        },
        { actorId: "agent-context-one", now: "2026-07-06T00:01:00.000Z" },
      );
      await contextStore.claimAgentWork(
        agentClaim({
          ownerAgentId: "agent-context-one",
          resourceId: "docs/context.md",
          paths: ["docs/context.md"],
          expiresAt: "2026-07-06T00:20:00.000Z",
        }),
        { now: "2026-07-06T00:00:00.000Z" },
      );

      const response = await fetch(
        `${contextBaseUrl}/api/work-context?repo=elizaos%2Feliza&ownerAgentId=agent-context-one&targetBranch=develop&query=context&now=2026-07-06T00%3A10%3A00.000Z`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.workContext.readOnly, true);
      assert.equal(body.workContext.filters.ownerAgentId, "agent-context-one");
      assert.equal(body.workContext.summary.cards, 2);
      assert.equal(body.workContext.summary.activeClaims, 1);
      assert.equal(
        body.workContext.snapshots.pages[0].title,
        "Agent context plan",
      );
      assert.ok(
        body.workContext.resume.ownedCardIds.includes(
          "queue:elizaos/eliza#824",
        ),
      );
      assert.ok(
        body.workContext.resume.pageIds.some((id) => id.includes("agent_plan")),
      );
      assert.equal(
        body.workContext.links.actionPlan,
        "/api/agents/agent-context-one/action-plan",
      );
      assert.ok(
        body.workContext.nextActions.some(
          (action) => action.id === "run_action_plan_before_pr",
        ),
      );
    });
  });

  it("serves a one-call agent cockpit for Eliza Cloud and agent runtimes", async () => {
    const cockpitConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(cockpitConfig, async (cockpitBaseUrl, cockpitStore) => {
      await cockpitStore.upsertQueueItem(
        readyItem({
          pullRequestId: 825,
          queueState: "waiting_for_review",
          ownerAgentId: "agent-cockpit-one",
          changedFiles: ["packages/core/src/cockpit.ts"],
          affectedPackages: ["core"],
        }),
      );
      await cockpitStore.upsertWorkItem(
        {
          repo: "elizaos/eliza",
          taskId: "cockpit-docs",
          title: "Document cockpit flow",
          kind: "task",
          state: "in_progress",
          ownerAgentId: "agent-cockpit-one",
          paths: ["packages/core/src/cockpit.ts"],
          packages: ["core"],
        },
        { actorId: "agent-cockpit-one", now: "2026-07-07T00:00:00.000Z" },
      );
      await cockpitStore.upsertRun({
        id: "run-cockpit-one",
        queueItemId: "elizaos/eliza#825",
        repo: "elizaos/eliza",
        pullRequestId: 825,
        ownerKind: "agent",
        ownerId: "agent-cockpit-one",
        status: "waiting_approval",
      });
      await cockpitStore.upsertApproval({
        id: "approval-cockpit-one",
        runId: "run-cockpit-one",
        queueItemId: "elizaos/eliza#825",
        status: "requested",
      });
      await cockpitStore.claimAgentWork(
        agentClaim({
          ownerAgentId: "agent-cockpit-one",
          resourceId: "packages/core/src/cockpit.ts",
          paths: ["packages/core/src/cockpit.ts"],
          expiresAt: "2026-07-07T00:20:00.000Z",
        }),
        { now: "2026-07-07T00:00:00.000Z" },
      );

      const response = await fetch(
        `${cockpitBaseUrl}/api/agents/agent-cockpit-one/cockpit?repo=elizaos/eliza&targetBranch=develop&readiness=false&now=2026-07-07T00:10:00.000Z`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.cockpit.agentId, "agent-cockpit-one");
      assert.equal(body.cockpit.status, "needs_attention");
      assert.equal(body.cockpit.summary.ownedCards, 2);
      assert.equal(body.cockpit.summary.needsHuman, 1);
      assert.equal(body.cockpit.summary.preflightAllowed, null);
      assert.equal(body.cockpit.summary.submissionAllowed, null);
      assert.equal(body.cockpit.focusCards[0].id, "queue:elizaos/eliza#825");
      assert.ok(
        body.cockpit.nextActions.some(
          (action) => action.id === "decide_approval",
        ),
      );
      assert.equal(
        body.cockpit.links.self,
        "/api/agents/agent-cockpit-one/cockpit?repo=elizaos%2Feliza&targetBranch=develop",
      );
      assert.equal(
        body.cockpit.snapshots.workflow.filters.ownerAgentId,
        "agent-cockpit-one",
      );
      assert.equal(
        body.cockpit.snapshots.workContext.filters.ownerAgentId,
        "agent-cockpit-one",
      );
      assert.deepEqual(body.cockpit.snapshots.preflight, {});
      assert.deepEqual(body.cockpit.snapshots.submissionGate, {});
    });
  });

  it("serves a merge queue summary for Eliza lanes", async () => {
    const mergeQueueConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      mergeQueueConfig,
      async (mergeQueueBaseUrl, mergeQueueStore) => {
        await mergeQueueStore.upsertQueueItem(
          readyItem({
            pullRequestId: 831,
            queueState: "ready",
            priority: 10,
            changedFiles: ["packages/core/src/a.ts"],
            affectedPackages: ["core"],
          }),
        );
        await mergeQueueStore.upsertQueueItem(
          readyItem({
            pullRequestId: 832,
            queueState: "ready",
            priority: 9,
            changedFiles: ["packages/runtime/src/b.ts"],
            affectedPackages: ["runtime"],
          }),
        );
        await mergeQueueStore.upsertQueueItem(
          readyItem({
            pullRequestId: 833,
            queueState: "waiting_for_review",
            priority: 8,
            reviewSatisfied: false,
            changedFiles: ["packages/client/src/c.ts"],
            affectedPackages: ["client"],
          }),
        );

        const response = await fetch(
          `${mergeQueueBaseUrl}/api/merge-queue?repo=elizaos/eliza&targetBranch=develop&now=2026-07-06T00:10:00.000Z`,
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.mergeQueue.filters.repo, "elizaos/eliza");
        assert.equal(body.mergeQueue.filters.targetBranch, "develop");
        assert.equal(body.mergeQueue.counts.items, 3);
        assert.equal(body.mergeQueue.counts.scheduled, 2);
        assert.equal(body.mergeQueue.counts.blocked, 1);
        assert.equal(body.mergeQueue.selectedPlan.planCount, 1);
        assert.equal(body.mergeQueue.selectedPlan.plans[0].pullRequestId, 831);
        assert.equal(body.mergeQueue.diagnostics.health, "attention");
        assert.equal(
          body.mergeQueue.diagnostics.nextMergeTarget.pullRequestId,
          831,
        );
        assert.equal(
          body.mergeQueue.diagnostics.blockers[0].reason,
          "review_required",
        );
        assert.equal(body.mergeQueue.lanes[0].state, "planned");
        assert.ok(
          body.mergeQueue.items
            .find((item) => item.pullRequestId === 833)
            .decision.blockers.includes("review_required"),
        );
      },
    );
  });

  it("serves a read-only merge train plan for agent queue execution", async () => {
    const mergeTrainConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_BATCHING: "true",
      MERGE_STEWARD_INTEGRATION_MAX_BATCH_SIZE: "2",
    });

    await withServer(
      mergeTrainConfig,
      async (mergeTrainBaseUrl, mergeTrainStore) => {
        await mergeTrainStore.upsertQueueItem(
          readyItem({
            pullRequestId: 841,
            queueState: "ready",
            priority: 10,
            changedFiles: ["packages/core/src/a.ts"],
            affectedPackages: ["core"],
          }),
        );
        await mergeTrainStore.upsertQueueItem(
          readyItem({
            pullRequestId: 842,
            queueState: "ready",
            priority: 9,
            changedFiles: ["packages/client/src/b.ts"],
            affectedPackages: ["client"],
          }),
        );

        const response = await fetch(
          `${mergeTrainBaseUrl}/api/merge-train?repo=elizaos/eliza&targetBranch=develop&now=2026-07-07T00:00:00.000Z`,
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.mergeTrain.readOnly, true);
        assert.equal(body.mergeTrain.status, "dry_run_ready");
        assert.equal(body.mergeTrain.selectedTrain.mode, "batch");
        assert.deepEqual(body.mergeTrain.selectedTrain.itemIds, [
          "elizaos/eliza#841",
          "elizaos/eliza#842",
        ]);
        assert.deepEqual(body.mergeTrain.selectedTrain.blockers, [
          "integration_dry_run",
        ]);
        assert.equal(
          body.mergeTrain.selectedTrain.nextAction,
          "review_dry_run_train",
        );
        assert.equal(body.mergeTrain.preflight.status, "dry_run_ready");
        assert.equal(body.mergeTrain.preflight.dryRunReviewReady, true);
        assert.equal(
          body.mergeTrain.preflight.checks.find(
            (check) => check.name === "required_checks_declared",
          ).status,
          "pass",
        );
        assert.equal(
          body.mergeTrain.lanes[0].nextAction,
          "execute_or_review_lane_train",
        );
        assert.equal(body.mergeTrain.links.queueRunOnce, "/api/queue/run-once");
      },
    );
  });

  it("serves release readiness for merge-window decisions", async () => {
    const readinessConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      readinessConfig,
      async (readinessBaseUrl, readinessStore) => {
        await readinessStore.upsertQueueItem(
          readyItem({
            pullRequestId: 836,
            queueState: "ready",
            priority: 10,
            changedFiles: ["packages/core/src/release.ts"],
            affectedPackages: ["core"],
          }),
        );
        await readinessStore.upsertQueueItem(
          readyItem({
            pullRequestId: 837,
            queueState: "waiting_for_review",
            priority: 8,
            reviewSatisfied: false,
            changedFiles: ["packages/client/src/review.ts"],
            affectedPackages: ["client"],
          }),
        );

        const response = await fetch(
          `${readinessBaseUrl}/api/release-readiness?repo=elizaos/eliza&targetBranch=develop&readiness=false&now=2026-07-06T00:10:00.000Z`,
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.releaseReadiness.filters.repo, "elizaos/eliza");
        assert.equal(body.releaseReadiness.status, "blocked");
        assert.equal(body.releaseReadiness.canOpenMergeWindow, false);
        assert.equal(body.releaseReadiness.counts.planned, 1);
        assert.equal(body.releaseReadiness.counts.blocked, 1);
        assert.ok(body.releaseReadiness.labels.includes("queue:blocked"));
        assert.ok(
          body.releaseReadiness.requiredActions.includes(
            "resolve_queue_blockers",
          ),
        );
        assert.deepEqual(body.releaseReadiness.snapshots.blockedItemIds, [
          "elizaos/eliza#837",
        ]);
      },
    );
  });

  it("blocks release readiness when live integration lacks strict work reservations", async () => {
    process.env.MERGE_STEWARD_TEST_FORGEJO_TOKEN = "local-forgejo-token";
    const liveConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      FORGEJO_TOKEN_ENV: "MERGE_STEWARD_TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "false",
    });

    try {
      await withServer(liveConfig, async (liveBaseUrl, liveStore) => {
        await liveStore.upsertQueueItem(
          readyItem({
            pullRequestId: 839,
            queueState: "ready",
            targetBranch: "develop",
            requiredChecks: [],
            reviewSatisfied: true,
            changedFiles: ["packages/core/src/live.ts"],
            affectedPackages: ["core"],
          }),
        );

        const response = await fetch(
          `${liveBaseUrl}/api/release-readiness?repo=elizaos/eliza&targetBranch=develop&now=2026-07-06T00:10:00.000Z`,
        );
        const body = await response.json();
        const strictCheck = body.releaseReadiness.checks.find(
          (check) => check.name === "strict_work_reservations",
        );

        assert.equal(response.status, 200);
        assert.equal(body.releaseReadiness.status, "blocked");
        assert.equal(body.releaseReadiness.canOpenMergeWindow, false);
        assert.equal(body.releaseReadiness.canAutoMerge, false);
        assert.equal(strictCheck.status, "fail");
        assert.equal(strictCheck.details.liveIntegrationActive, true);
        assert.ok(body.releaseReadiness.labels.includes("reservation:blocked"));
        assert.ok(
          body.releaseReadiness.requiredActions.includes(
            "enable_strict_work_reservations",
          ),
        );
      });
    } finally {
      delete process.env.MERGE_STEWARD_TEST_FORGEJO_TOKEN;
    }
  });

  it("can require repository protection in release readiness", async () => {
    const readinessConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      readinessConfig,
      async (readinessBaseUrl, readinessStore) => {
        await readinessStore.upsertRepoPolicy({
          repo: "elizaos/eliza",
          queueMode: "serialized",
          protectedBranches: ["develop"],
          requiredChecks: ["test", "lint"],
          trustedActors: ["agent-one"],
          allowForks: false,
        });
        await readinessStore.upsertQueueItem(
          readyItem({
            pullRequestId: 838,
            queueState: "ready",
            targetBranch: "develop",
            requiredChecks: ["test", "lint"],
            checkResults: { test: "success", lint: "success" },
            reviewSatisfied: true,
            changedFiles: ["packages/core/src/protection.ts"],
            affectedPackages: ["core"],
          }),
        );

        const response = await fetch(
          `${readinessBaseUrl}/api/release-readiness?repo=elizaos/eliza&targetBranch=develop&readiness=false&requireRepositoryProtection=true&requireLiveProtection=false&now=2026-07-06T00:10:00.000Z`,
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.releaseReadiness.status, "blocked");
        assert.equal(body.releaseReadiness.canOpenMergeWindow, false);
        assert.ok(
          body.releaseReadiness.labels.includes("repo-protection:blocked"),
        );
        assert.equal(
          body.releaseReadiness.checks.find(
            (check) => check.name === "repository_protection_verified",
          ).status,
          "fail",
        );
        assert.equal(
          body.releaseReadiness.snapshots.repositoryProtection.status,
          "watch",
        );
        assert.ok(
          body.releaseReadiness.requiredActions.includes(
            "verify_live_branch_protection_before_cutover",
          ),
        );
      },
    );
  });

  it("serves agent insights for Eliza queue risk routing", async () => {
    const insightsConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(insightsConfig, async (insightsBaseUrl, insightsStore) => {
      await insightsStore.upsertQueueItem(
        readyItem({
          pullRequestId: 841,
          queueState: "ready",
          priority: 10,
          ownerAgentId: "agent-insights-one",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
          requiredChecks: ["unit"],
          checkResults: { unit: "failure" },
        }),
      );
      await insightsStore.upsertQueueItem(
        readyItem({
          pullRequestId: 842,
          queueState: "ready",
          priority: 9,
          ownerAgentId: "agent-insights-two",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
          targetCommitsBehind: 30,
        }),
      );
      await insightsStore.upsertQueueItem(
        readyItem({
          pullRequestId: 843,
          queueState: "waiting_for_review",
          priority: 8,
          ownerAgentId: "agent-insights-three",
          reviewSatisfied: false,
          changedFiles: ["packages/client/src/chat.ts"],
          affectedPackages: ["client"],
        }),
      );
      await insightsStore.upsertRun({
        id: "run-insights-three",
        queueItemId: "elizaos/eliza#843",
        repo: "elizaos/eliza",
        pullRequestId: 843,
        ownerKind: "agent",
        ownerId: "agent-insights-three",
        status: "waiting_approval",
      });
      await insightsStore.upsertApproval({
        id: "approval-insights-three",
        runId: "run-insights-three",
        queueItemId: "elizaos/eliza#843",
        status: "requested",
      });
      await insightsStore.claimAgentWork(
        agentClaim({
          ownerAgentId: "agent-insights-one",
          resourceId: "packages/core/src/runtime.ts",
          paths: ["packages/core/src/runtime.ts"],
          expiresAt: "2026-07-06T00:00:00.000Z",
        }),
        { now: "2026-07-06T00:00:00.000Z" },
      );

      const response = await fetch(
        `${insightsBaseUrl}/api/agent-insights?repo=elizaos/eliza&targetBranch=develop&now=2026-07-06T00:10:00.000Z&limit=10`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.insights.filters.repo, "elizaos/eliza");
      assert.equal(body.insights.filters.targetBranch, "develop");
      assert.equal(body.insights.counts.items, 3);
      assert.equal(body.insights.counts.failedChecks, 1);
      assert.equal(body.insights.counts.staleBranches, 1);
      assert.equal(body.insights.counts.duplicateRiskItems, 2);
      assert.equal(body.insights.counts.needsHuman, 1);
      assert.equal(
        body.insights.recommendations[0].action,
        "resolve_human_decision",
      );
      assert.equal(body.insights.ciFailureRoutes[0].check, "unit");
      assert.equal(body.insights.staleBranches[0].itemId, "elizaos/eliza#842");
      assert.equal(
        body.insights.items.find((item) => item.pullRequestId === 841).claims
          .stale.length,
        1,
      );
    });
  });

  it("serves agent capacity and assignment suggestions", async () => {
    const agentsConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(agentsConfig, async (agentsBaseUrl, agentsStore) => {
      await agentsStore.upsertQueueItem(
        readyItem({
          pullRequestId: 851,
          queueState: "ready",
          priority: 10,
          ownerAgentId: "agent-capacity-core",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
          requiredChecks: ["unit"],
          checkResults: { unit: "failure" },
        }),
      );
      await agentsStore.upsertQueueItem(
        readyItem({
          pullRequestId: 852,
          queueState: "ready",
          priority: 9,
          ownerAgentId: "agent-capacity-ui",
          changedFiles: ["packages/client/src/chat.ts"],
          affectedPackages: ["client"],
        }),
      );
      await agentsStore.upsertQueueItem(
        readyItem({
          pullRequestId: 853,
          queueState: "ready",
          priority: 8,
          ownerAgentId: null,
          changedFiles: ["packages/core/src/memory.ts"],
          affectedPackages: ["core"],
        }),
      );
      await agentsStore.claimAgentWork(
        agentClaim({
          ownerAgentId: "agent-capacity-repair",
          resourceId: "packages/client/src/old.ts",
          paths: ["packages/client/src/old.ts"],
          expiresAt: "2026-07-06T00:00:00.000Z",
        }),
        { now: "2026-07-06T00:00:00.000Z" },
      );

      const response = await fetch(
        `${agentsBaseUrl}/api/agents?repo=elizaos/eliza&targetBranch=develop&now=2026-07-06T00:10:00.000Z`,
      );
      const body = await response.json();
      const core = body.agents.agents.find(
        (agent) => agent.agentId === "agent-capacity-core",
      );
      const ui = body.agents.agents.find(
        (agent) => agent.agentId === "agent-capacity-ui",
      );
      const repair = body.agents.agents.find(
        (agent) => agent.agentId === "agent-capacity-repair",
      );

      assert.equal(response.status, 200);
      assert.equal(body.agents.filters.repo, "elizaos/eliza");
      assert.equal(body.agents.filters.targetBranch, "develop");
      assert.equal(body.agents.counts.agents, 3);
      assert.equal(body.agents.counts.unassignedItems, 1);
      assert.equal(core.health, "needs-triage");
      assert.equal(core.counts.failedChecks, 1);
      assert.equal(ui.health, "available");
      assert.equal(repair.counts.staleClaims, 1);
      assert.equal(
        body.agents.assignmentSuggestions[0].agentId,
        "agent-capacity-ui",
      );
      assert.equal(
        body.agents.assignmentSuggestions[0].itemId,
        "elizaos/eliza#853",
      );
    });
  });

  it("serves an agent submission gate for overload control", async () => {
    const gateConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(gateConfig, async (gateBaseUrl, gateStore) => {
      await gateStore.upsertQueueItem(
        readyItem({
          pullRequestId: 861,
          queueState: "blocked_checks",
          ownerAgentId: "agent-submission-spam",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
          requiredChecks: ["unit"],
          checkResults: { unit: "failure" },
        }),
      );
      await gateStore.claimAgentWork(
        agentClaim({
          ownerAgentId: "agent-submission-spam",
          resourceId: "packages/core/src/stale.ts",
          paths: ["packages/core/src/stale.ts"],
          expiresAt: "2026-07-06T00:00:00.000Z",
        }),
        { now: "2026-07-06T00:00:00.000Z" },
      );
      await gateStore.upsertRun({
        id: "run-submission-spam",
        queueItemId: "elizaos/eliza#861",
        repo: "elizaos/eliza",
        pullRequestId: 861,
        targetBranch: "develop",
        ownerKind: "agent",
        ownerId: "agent-submission-spam",
        status: "failed",
        finishedAt: "2026-07-06T00:03:00.000Z",
        updatedAt: "2026-07-06T00:03:00.000Z",
      });

      const response = await fetch(
        `${gateBaseUrl}/api/agents/agent-submission-spam/submission-gate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repo: "elizaos/eliza",
            targetBranch: "develop",
            now: "2026-07-06T00:10:00.000Z",
            since: "2026-07-06T00:00:00.000Z",
            proposedItem: {
              repo: "elizaos/eliza",
              ownerAgentId: "agent-submission-spam",
              authorKind: "agent",
              agentKnown: true,
              hasIssueLink: true,
              hasExecutionPlan: true,
              hasValidationPlan: true,
              changedLines: 1200,
              changedFiles: ["packages/core/src/new-runtime.ts"],
              affectedPackages: ["core"],
            },
            validationCommands: ["turbo run typecheck"],
            requireWorkReservation: true,
          }),
        },
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.gate.agentId, "agent-submission-spam");
      assert.equal(body.gate.decision.allowed, false);
      assert.equal(body.gate.decision.state, "triage_required");
      assert.ok(body.gate.decision.blockers.includes("triage_clear"));
      assert.ok(body.gate.decision.blockers.includes("validation_budget"));
      assert.ok(
        body.gate.decision.requiredActions.includes(
          "use_recommended_scoped_commands",
        ),
      );
      assert.equal(
        body.gate.gates.find((gate) => gate.name === "validation_budget")
          .evidence.recommendedCommands[0],
        "turbo run typecheck --filter=@elizaos/core",
      );
      assert.ok(body.gate.labels.includes("submission:blocked"));
      assert.ok(body.gate.labels.includes("needs-triage"));
      assert.ok(body.gate.labels.includes("validation:broad-blocked"));
    });
  });

  it("serves agent work preflight for claim and PR overlap prediction", async () => {
    const preflightConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      preflightConfig,
      async (preflightBaseUrl, preflightStore) => {
        await preflightStore.upsertQueueItem(
          readyItem({
            pullRequestId: 862,
            ownerAgentId: "agent-one",
            changedFiles: ["packages/core/src/runtime.ts"],
            affectedPackages: ["core"],
          }),
        );
        await preflightStore.claimAgentWork(
          {
            repo: "elizaos/eliza",
            resourceKind: "path",
            resourceId: "packages/core/src/runtime.ts",
            ownerAgentId: "agent-one",
          },
          {
            now: "2026-07-06T00:00:00.000Z",
            ttlMs: 30 * 60 * 1000,
          },
        );
        await preflightStore.upsertWorkItem({
          repo: "elizaos/eliza",
          kind: "path",
          state: "in_progress",
          title: "Runtime Work item already in progress",
          ownerAgentId: "agent-three",
          targetBranch: "develop",
          paths: ["packages/core/src/runtime.ts"],
          packages: ["core"],
        });

        const response = await fetch(
          `${preflightBaseUrl}/api/agents/agent-two/work-preflight`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              now: "2026-07-06T00:10:00.000Z",
              changedFiles: ["packages/core/src/runtime.ts"],
              affectedPackages: ["core"],
            }),
          },
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.preflight.agentId, "agent-two");
        assert.equal(body.preflight.decision.allowed, false);
        assert.ok(
          body.preflight.decision.blockers.includes("active_claim_conflict"),
        );
        assert.ok(
          body.preflight.decision.blockers.includes("overlapping_open_prs"),
        );
        assert.ok(
          body.preflight.decision.blockers.includes(
            "active_work_item_conflict",
          ),
        );
        assert.equal(body.preflight.overlaps.queueItems[0].pullRequestId, 862);
        assert.equal(
          body.preflight.overlaps.claims[0].ownerAgentId,
          "agent-one",
        );
        assert.equal(
          body.preflight.overlaps.workItems[0].ownerAgentId,
          "agent-three",
        );
        assert.equal(
          body.preflight.suggestedClaims[0].resourceId,
          "packages/core/src/runtime.ts",
        );
        assert.equal(body.preflight.splitPlan.recommended, true);
        assert.equal(
          body.preflight.splitPlan.strategy,
          "split_conflicted_work_from_ready_lanes",
        );
        assert.equal(body.preflight.splitPlan.units[0].state, "blocked");
        assert.ok(
          body.preflight.splitPlan.nextActions.includes(
            "coordinate_blocked_split_units",
          ),
        );
        assert.ok(body.preflight.labels.includes("agent:claimed-conflict"));
        assert.ok(body.preflight.labels.includes("agent:work-item-conflict"));
        assert.ok(body.preflight.labels.includes("agent:duplicate-risk"));
      },
    );
  });

  it("reserves agent work claims after a clean preflight", async () => {
    const reservationConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      reservationConfig,
      async (reservationBaseUrl, reservationStore) => {
        const reserveResponse = await fetch(
          `${reservationBaseUrl}/api/agents/agent-reserve/work-reservation`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              now: "2026-07-06T00:10:00.000Z",
              ttlMs: 60_000,
              changedFiles: ["packages/core/src/runtime.ts"],
              affectedPackages: ["core"],
              workItem: {
                taskId: "runtime-reservation",
                title: "Runtime reservation",
              },
            }),
          },
        );
        const reserveBody = await reserveResponse.json();
        const activeClaims = await reservationStore.listAgentClaims({
          ownerAgentId: "agent-reserve",
          status: "active",
        });
        const reservedWorkItems = await reservationStore.listWorkItems({
          repo: "elizaos/eliza",
          ownerAgentId: "agent-reserve",
        });
        const strictGateResponse = await fetch(
          `${reservationBaseUrl}/api/agents/agent-reserve/submission-gate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              now: "2026-07-06T00:10:30.000Z",
              requireWorkItem: true,
              requireWorkReservation: true,
              proposedItem: {
                repo: "elizaos/eliza",
                ownerAgentId: "agent-reserve",
                authorKind: "agent",
                agentKnown: true,
                taskId: "runtime-reservation",
                hasIssueLink: true,
                hasExecutionPlan: true,
                hasValidationPlan: true,
                changedLines: 48,
                changedFiles: ["packages/core/src/runtime.ts"],
                affectedPackages: ["core"],
              },
            }),
          },
        );
        const strictGateBody = await strictGateResponse.json();

        const blockedResponse = await fetch(
          `${reservationBaseUrl}/api/agents/agent-other/work-reservation`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              now: "2026-07-06T00:10:30.000Z",
              changedFiles: ["packages/core/src/runtime.ts"],
              affectedPackages: ["core"],
            }),
          },
        );
        const blockedBody = await blockedResponse.json();
        const otherClaims = await reservationStore.listAgentClaims({
          ownerAgentId: "agent-other",
          status: "active",
        });

        assert.equal(reserveResponse.status, 200);
        assert.equal(reserveBody.reservation.reserved, true);
        assert.equal(reserveBody.reservation.reason, "reserved");
        assert.equal(reserveBody.reservation.claims.length, 2);
        assert.deepEqual(
          reserveBody.reservation.claims.map((claim) => claim.resourceKind),
          ["path", "package"],
        );
        assert.equal(
          reserveBody.reservation.claims[0].expiresAt,
          "2026-07-06T00:11:00.000Z",
        );
        assert.equal(reserveBody.reservation.workItemAction, "upserted");
        assert.equal(
          reserveBody.reservation.workItem.id,
          "work:elizaos/eliza:task:runtime-reservation",
        );
        assert.equal(reserveBody.reservation.workItem.state, "claimed");
        assert.deepEqual(reserveBody.reservation.workItem.paths, [
          "packages/core/src/runtime.ts",
        ]);
        assert.ok(
          reserveBody.reservation.labels.includes("work-reservation:reserved"),
        );
        assert.ok(
          reserveBody.reservation.labels.includes("work-item:reserved"),
        );
        assert.equal(activeClaims.length, 2);
        assert.deepEqual(
          activeClaims.map((claim) => claim.resourceKind).sort(),
          ["package", "path"],
        );
        assert.equal(
          activeClaims.find((claim) => claim.resourceKind === "path").metadata
            .source,
          "agent-work-reservation",
        );
        assert.equal(reservedWorkItems.length, 1);
        assert.equal(
          reservedWorkItems[0].id,
          "work:elizaos/eliza:task:runtime-reservation",
        );
        assert.equal(strictGateResponse.status, 200);
        assert.equal(
          strictGateBody.gate.gates.find((gate) => gate.name === "work_item")
            .status,
          "pass",
        );
        assert.equal(
          strictGateBody.gate.gates.find(
            (gate) => gate.name === "work_reservation",
          ).status,
          "pass",
        );
        assert.equal(
          strictGateBody.gate.decision.blockers.includes("work_item"),
          false,
        );
        assert.equal(
          strictGateBody.gate.decision.blockers.includes("work_reservation"),
          false,
        );

        assert.equal(blockedResponse.status, 409);
        assert.equal(blockedBody.reservation.reserved, false);
        assert.equal(blockedBody.reservation.reason, "preflight_blocked");
        assert.ok(
          blockedBody.reservation.preflight.decision.blockers.includes(
            "active_claim_conflict",
          ),
        );
        assert.deepEqual(blockedBody.reservation.attempted, []);
        assert.deepEqual(otherClaims, []);
      },
    );
  });

  it("serves agent performance telemetry", async () => {
    const performanceConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      performanceConfig,
      async (performanceBaseUrl, performanceStore) => {
        await performanceStore.upsertQueueItem(
          readyItem({
            pullRequestId: 871,
            queueState: "ready",
            priority: 10,
            ownerAgentId: "agent-performance-one",
            changedFiles: ["packages/core/src/performance.ts"],
            affectedPackages: ["core"],
          }),
        );
        await performanceStore.upsertQueueItem(
          readyItem({
            pullRequestId: 872,
            queueState: "running",
            priority: 9,
            ownerAgentId: "agent-performance-two",
            changedFiles: ["packages/client/src/performance.ts"],
            affectedPackages: ["client"],
          }),
        );
        const transferable = await performanceStore.claimAgentWork(
          agentClaim({
            ownerAgentId: "agent-performance-one",
            resourceId: "packages/core/src/handoff.ts",
            paths: ["packages/core/src/handoff.ts"],
            expiresAt: "2026-07-06T00:30:00.000Z",
          }),
          { now: "2026-07-06T00:01:00.000Z" },
        );
        await performanceStore.transferAgentClaim(transferable.claim.id, {
          fromOwnerAgentId: "agent-performance-one",
          toOwnerAgentId: "agent-performance-two",
          reason: "handoff",
          now: "2026-07-06T00:04:00.000Z",
          ttlMs: 30 * 60 * 1000,
        });
        await performanceStore.claimAgentWork(
          agentClaim({
            ownerAgentId: "agent-performance-one",
            resourceId: "packages/core/src/stale.ts",
            paths: ["packages/core/src/stale.ts"],
            expiresAt: "2026-07-06T00:00:00.000Z",
          }),
          { now: "2026-07-06T00:02:00.000Z" },
        );
        await performanceStore.upsertRun({
          id: "run-performance-one",
          queueItemId: "elizaos/eliza#871",
          repo: "elizaos/eliza",
          pullRequestId: 871,
          targetBranch: "develop",
          ownerKind: "agent",
          ownerId: "agent-performance-one",
          status: "failed",
          finishedAt: "2026-07-06T00:03:00.000Z",
          updatedAt: "2026-07-06T00:03:00.000Z",
        });

        const response = await fetch(
          `${performanceBaseUrl}/api/agent-performance?repo=elizaos/eliza&targetBranch=develop&since=2026-07-06T00:00:00.000Z&now=2026-07-06T00:10:00.000Z`,
        );
        const body = await response.json();
        const first = body.performance.agents.find(
          (agent) => agent.agentId === "agent-performance-one",
        );
        const second = body.performance.agents.find(
          (agent) => agent.agentId === "agent-performance-two",
        );

        assert.equal(response.status, 200);
        assert.equal(body.performance.filters.repo, "elizaos/eliza");
        assert.equal(body.performance.filters.targetBranch, "develop");
        assert.equal(body.performance.counts.agents, 2);
        assert.equal(body.performance.counts.handoffs, 1);
        assert.equal(first.health, "needs-triage");
        assert.equal(first.counts.staleClaims, 1);
        assert.equal(first.counts.failedRuns, 1);
        assert.equal(first.counts.transferredOut, 1);
        assert.equal(second.counts.activeClaims, 1);
        assert.equal(second.counts.runningQueueItems, 1);
        assert.equal(second.counts.transferredIn, 1);
        assert.equal(body.performance.leaders.mostHandoffs.length, 2);
      },
    );
  });

  it("serves compact agent routing recommendations", async () => {
    const routingConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(routingConfig, async (routingBaseUrl, routingStore) => {
      await routingStore.upsertQueueItem(
        readyItem({
          pullRequestId: 881,
          queueState: "ready",
          priority: 10,
          ownerAgentId: "agent-routing-steady",
          changedFiles: ["packages/core/src/routing.ts"],
          affectedPackages: ["core"],
        }),
      );
      await routingStore.upsertQueueItem(
        readyItem({
          pullRequestId: 882,
          queueState: "ready",
          priority: 9,
          ownerAgentId: "agent-routing-flaky",
          changedFiles: ["packages/core/src/failure.ts"],
          affectedPackages: ["core"],
        }),
      );
      await routingStore.upsertQueueItem(
        readyItem({
          pullRequestId: 883,
          queueState: "ready",
          priority: 8,
          ownerAgentId: null,
          changedFiles: ["packages/core/src/unassigned.ts"],
          affectedPackages: ["core"],
        }),
      );
      await routingStore.upsertRun({
        id: "run-routing-flaky",
        queueItemId: "elizaos/eliza#882",
        repo: "elizaos/eliza",
        pullRequestId: 882,
        targetBranch: "develop",
        ownerKind: "agent",
        ownerId: "agent-routing-flaky",
        status: "failed",
        finishedAt: "2026-07-06T00:03:00.000Z",
        updatedAt: "2026-07-06T00:03:00.000Z",
      });

      const response = await fetch(
        `${routingBaseUrl}/api/agent-routing?repo=elizaos/eliza&targetBranch=develop&since=2026-07-06T00:00:00.000Z&now=2026-07-06T00:10:00.000Z&maxRecommendations=5`,
      );
      const body = await response.json();
      const blockedFlaky = body.routing.blockedAgents.find(
        (agent) => agent.agentId === "agent-routing-flaky",
      );

      assert.equal(response.status, 200);
      assert.equal(body.routing.filters.repo, "elizaos/eliza");
      assert.equal(body.routing.counts.recommendations, 1);
      assert.equal(
        body.routing.recommendations[0].agentId,
        "agent-routing-steady",
      );
      assert.equal(
        body.routing.routableAgents[0].agentId,
        "agent-routing-steady",
      );
      assert.ok(blockedFlaky.reasons.includes("performance_needs-triage"));
      assert.ok(blockedFlaky.reasons.includes("recent_failed_runs"));
    });
  });

  it("serves repo search across steward state and supplied agent documents", async () => {
    const searchConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(searchConfig, async (searchBaseUrl, searchStore) => {
      await searchStore.upsertQueueItem(
        readyItem({
          pullRequestId: 889,
          title: "fix: repair capacitor bridge typecheck",
          queueState: "blocked_checks",
          ownerAgentId: "agent-ci-runtime",
          targetBranch: "develop",
          changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
          affectedPackages: ["plugin-capacitor-bridge"],
          requiredChecks: ["typecheck"],
          checkResults: { typecheck: "failure" },
        }),
      );
      await searchStore.claimAgentWork(
        {
          repo: "elizaos/eliza",
          resourceKind: "path",
          resourceId: "packages/plugin-capacitor-bridge/src/index.ts",
          ownerAgentId: "agent-ci-runtime",
        },
        {
          now: "2026-07-06T00:00:00.000Z",
          ttlMs: 30 * 60 * 1000,
        },
      );

      const response = await fetch(`${searchBaseUrl}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: "elizaos/eliza",
          query: "capacitor bridge typecheck failed",
          documents: [
            {
              kind: "actions_log",
              id: "log-889",
              repo: "elizaos/eliza",
              title: "capacitor bridge typecheck failed",
              body: "tsc failed in packages/plugin-capacitor-bridge/src/index.ts with missing export.",
            },
          ],
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.search.filters.repo, "elizaos/eliza");
      assert.ok(body.search.summary.matchedDocuments >= 2);
      assert.equal(body.search.results[0].kind, "actions_log");
      assert.ok(
        body.search.results.some((result) => result.id === "elizaos/eliza#889"),
      );
      assert.ok(body.search.facets.kinds.pull_request >= 1);
      assert.ok(body.search.labels.includes("search:matched"));
    });
  });

  it("serves durable work item CRUD and indexes work items for search", async () => {
    const workItemConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(workItemConfig, async (workItemBaseUrl) => {
      const cycleResponse = await fetch(`${workItemBaseUrl}/api/work-cycles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: "elizaos/eliza",
          title: "July agent hardening",
          state: "active",
          ownerAgentId: "agent-docs",
          actorId: "agent-docs",
          now: "2026-07-07T00:00:00.000Z",
        }),
      });
      const createdCycle = await cycleResponse.json();

      const moduleResponse = await fetch(
        `${workItemBaseUrl}/api/work-modules`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repo: "elizaos/eliza",
            title: "Docs",
            ownerAgentId: "agent-docs",
            paths: ["docs"],
            packages: ["docs"],
            actorId: "agent-docs",
            now: "2026-07-07T00:00:30.000Z",
          }),
        },
      );
      const createdModule = await moduleResponse.json();

      const viewResponse = await fetch(`${workItemBaseUrl}/api/work-views`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: "elizaos/eliza",
          title: "Docs dashboard",
          kind: "dashboard",
          ownerAgentId: "agent-docs",
          filters: {
            state: ["in_progress"],
            packages: ["docs"],
          },
          actorId: "agent-docs",
          now: "2026-07-07T00:00:45.000Z",
        }),
      });
      const createdView = await viewResponse.json();

      const createResponse = await fetch(`${workItemBaseUrl}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: "elizaos/eliza",
          taskId: "docs-intake",
          title: "Document agent intake",
          ownerAgentId: "agent-docs",
          cycleId: createdCycle.workCycle.id,
          moduleId: createdModule.workModule.id,
          paths: ["docs/steward-runtime-model.md"],
          packages: ["docs"],
          labels: ["docs"],
          actorId: "agent-docs",
          now: "2026-07-07T00:00:00.000Z",
        }),
      });
      const created = await createResponse.json();

      const pageResponse = await fetch(`${workItemBaseUrl}/api/work-pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: "elizaos/eliza",
          kind: "agent_plan",
          title: "Docs intake plan",
          summary: "Plan the docs intake work",
          workItemId: created.workItem.id,
          cycleId: createdCycle.workCycle.id,
          moduleId: createdModule.workModule.id,
          ownerAgentId: "agent-docs",
          body: "## Plan\n\n- Update steward docs.\n- Link the work item.",
          tags: ["docs", "plan"],
          actorId: "agent-docs",
          now: "2026-07-07T00:01:00.000Z",
        }),
      });
      const createdPage = await pageResponse.json();

      const listResponse = await fetch(
        `${workItemBaseUrl}/api/work-items?repo=elizaos/eliza&ownerAgentId=agent-docs`,
      );
      const listed = await listResponse.json();

      const cycleListResponse = await fetch(
        `${workItemBaseUrl}/api/work-cycles?repo=elizaos/eliza&state=active`,
      );
      const listedCycles = await cycleListResponse.json();

      const moduleListResponse = await fetch(
        `${workItemBaseUrl}/api/work-modules?repo=elizaos/eliza&ownerAgentId=agent-docs`,
      );
      const listedModules = await moduleListResponse.json();

      const viewListResponse = await fetch(
        `${workItemBaseUrl}/api/work-views?repo=elizaos/eliza&kind=dashboard`,
      );
      const listedViews = await viewListResponse.json();

      const pageListResponse = await fetch(
        `${workItemBaseUrl}/api/work-pages?repo=elizaos/eliza&kind=agent_plan&workItemId=${encodeURIComponent(created.workItem.id)}`,
      );
      const listedPages = await pageListResponse.json();

      const itemResponse = await fetch(
        `${workItemBaseUrl}/api/work-items/item?id=${encodeURIComponent(created.workItem.id)}`,
      );
      const fetched = await itemResponse.json();

      const cycleItemResponse = await fetch(
        `${workItemBaseUrl}/api/work-cycles/item?id=${encodeURIComponent(createdCycle.workCycle.id)}`,
      );
      const fetchedCycle = await cycleItemResponse.json();

      const moduleItemResponse = await fetch(
        `${workItemBaseUrl}/api/work-modules/item?id=${encodeURIComponent(createdModule.workModule.id)}`,
      );
      const fetchedModule = await moduleItemResponse.json();

      const viewItemResponse = await fetch(
        `${workItemBaseUrl}/api/work-views/item?id=${encodeURIComponent(createdView.workView.id)}`,
      );
      const fetchedView = await viewItemResponse.json();

      const pageItemResponse = await fetch(
        `${workItemBaseUrl}/api/work-pages/item?id=${encodeURIComponent(createdPage.workPage.id)}`,
      );
      const fetchedPage = await pageItemResponse.json();

      const transitionResponse = await fetch(
        `${workItemBaseUrl}/api/work-items/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: created.workItem.id,
            state: "in_progress",
            transitionedBy: "agent-docs",
            reason: "starting docs intake",
            now: "2026-07-07T00:05:00.000Z",
          }),
        },
      );
      const transitioned = await transitionResponse.json();

      const cycleTransitionResponse = await fetch(
        `${workItemBaseUrl}/api/work-cycles/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: createdCycle.workCycle.id,
            state: "completed",
            transitionedBy: "agent-docs",
            reason: "docs cycle demo completed",
            now: "2026-07-07T00:06:00.000Z",
          }),
        },
      );
      const transitionedCycle = await cycleTransitionResponse.json();

      const moduleTransitionResponse = await fetch(
        `${workItemBaseUrl}/api/work-modules/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: createdModule.workModule.id,
            state: "archived",
            transitionedBy: "agent-docs",
            reason: "docs module demo archived",
            now: "2026-07-07T00:07:00.000Z",
          }),
        },
      );
      const transitionedModule = await moduleTransitionResponse.json();

      const progressResponse = await fetch(
        `${workItemBaseUrl}/api/work-progress?repo=elizaos/eliza&ownerAgentId=agent-docs`,
      );
      const progress = await progressResponse.json();

      const dashboardResponse = await fetch(
        `${workItemBaseUrl}/api/work-dashboard?repo=elizaos/eliza&ownerAgentId=agent-docs&now=2026-07-07T00%3A08%3A00.000Z`,
      );
      const dashboard = await dashboardResponse.json();

      const viewEvaluationResponse = await fetch(
        `${workItemBaseUrl}/api/work-views/evaluate?id=${encodeURIComponent(createdView.workView.id)}&repo=elizaos/eliza&ownerAgentId=agent-docs`,
      );
      const evaluatedView = await viewEvaluationResponse.json();

      const inlineViewEvaluationResponse = await fetch(
        `${workItemBaseUrl}/api/work-views/evaluate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repo: "elizaos/eliza",
            ownerAgentId: "agent-docs",
            title: "Inline docs view",
            kind: "kanban",
            filters: {
              packages: ["docs"],
            },
          }),
        },
      );
      const inlineEvaluatedView = await inlineViewEvaluationResponse.json();

      const viewTransitionResponse = await fetch(
        `${workItemBaseUrl}/api/work-views/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: createdView.workView.id,
            state: "archived",
            transitionedBy: "agent-docs",
            reason: "dashboard demo archived",
            now: "2026-07-07T00:09:00.000Z",
          }),
        },
      );
      const transitionedView = await viewTransitionResponse.json();

      const pageTransitionResponse = await fetch(
        `${workItemBaseUrl}/api/work-pages/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: createdPage.workPage.id,
            state: "archived",
            transitionedBy: "agent-docs",
            reason: "plan moved into runbook",
            now: "2026-07-07T00:10:00.000Z",
          }),
        },
      );
      const transitionedPage = await pageTransitionResponse.json();

      const searchResponse = await fetch(
        `${workItemBaseUrl}/api/search?q=docs+intake&repo=elizaos/eliza&kind=work_item`,
      );
      const searched = await searchResponse.json();

      const planningSearchResponse = await fetch(
        `${workItemBaseUrl}/api/search?q=july+docs+dashboard&repo=elizaos/eliza&kind=work_cycle&kind=work_module&kind=work_view&kind=work_page`,
      );
      const planningSearch = await planningSearchResponse.json();

      const pageSearchResponse = await fetch(
        `${workItemBaseUrl}/api/search?q=steward+docs+plan&repo=elizaos/eliza&kind=work_page`,
      );
      const pageSearch = await pageSearchResponse.json();

      assert.equal(cycleResponse.status, 200);
      assert.equal(
        createdCycle.workCycle.id,
        "cycle:elizaos/eliza:july-agent-hardening",
      );
      assert.equal(moduleResponse.status, 200);
      assert.equal(createdModule.workModule.id, "module:elizaos/eliza:docs");
      assert.equal(viewResponse.status, 200);
      assert.equal(
        createdView.workView.id,
        "view:elizaos/eliza:docs-dashboard",
      );
      assert.equal(createResponse.status, 200);
      assert.equal(created.workItem.id, "work:elizaos/eliza:task:docs-intake");
      assert.equal(created.workItem.cycleId, createdCycle.workCycle.id);
      assert.equal(created.workItem.moduleId, createdModule.workModule.id);
      assert.equal(pageResponse.status, 200);
      assert.equal(
        createdPage.workPage.id,
        "page:elizaos/eliza:work:work-elizaos-eliza-task-docs-intake:agent_plan",
      );
      assert.equal(createdPage.workPage.format, "markdown");
      assert.equal(createdPage.workPage.workItemId, created.workItem.id);
      assert.equal(listResponse.status, 200);
      assert.equal(listed.workItems.length, 1);
      assert.equal(cycleListResponse.status, 200);
      assert.equal(listedCycles.workCycles.length, 1);
      assert.equal(moduleListResponse.status, 200);
      assert.equal(listedModules.workModules.length, 1);
      assert.equal(viewListResponse.status, 200);
      assert.equal(listedViews.workViews.length, 1);
      assert.equal(pageListResponse.status, 200);
      assert.equal(listedPages.workPages.length, 1);
      assert.equal(itemResponse.status, 200);
      assert.equal(fetched.workItem.title, "Document agent intake");
      assert.equal(cycleItemResponse.status, 200);
      assert.equal(fetchedCycle.workCycle.title, "July agent hardening");
      assert.equal(moduleItemResponse.status, 200);
      assert.equal(fetchedModule.workModule.title, "Docs");
      assert.equal(viewItemResponse.status, 200);
      assert.equal(fetchedView.workView.title, "Docs dashboard");
      assert.equal(pageItemResponse.status, 200);
      assert.equal(fetchedPage.workPage.title, "Docs intake plan");
      assert.match(fetchedPage.workPage.body, /Update steward docs/);
      assert.equal(transitionResponse.status, 200);
      assert.equal(transitioned.workItem.state, "in_progress");
      assert.equal(
        transitioned.workItem.metadata.transitions[0].reason,
        "starting docs intake",
      );
      assert.equal(cycleTransitionResponse.status, 200);
      assert.equal(transitionedCycle.workCycle.state, "completed");
      assert.equal(moduleTransitionResponse.status, 200);
      assert.equal(transitionedModule.workModule.state, "archived");
      assert.equal(progressResponse.status, 200);
      assert.equal(progress.workProgress.summary.total, 1);
      assert.equal(progress.workProgress.cycles[0].progress.active, 1);
      assert.equal(progress.workProgress.modules[0].progress.active, 1);
      assert.equal(dashboardResponse.status, 200);
      assert.equal(dashboard.workDashboard.summary.pages, 1);
      assert.equal(dashboard.workDashboard.summary.savedViews, 1);
      assert.equal(dashboard.workDashboard.views.saved[0].count, 1);
      assert.deepEqual(dashboard.workDashboard.views.saved[0].itemIds, [
        created.workItem.id,
      ]);
      assert.deepEqual(dashboard.workDashboard.views.saved[0].pageIds, [
        createdPage.workPage.id,
      ]);
      assert.equal(viewEvaluationResponse.status, 200);
      assert.equal(evaluatedView.workViewEvaluation.summary.totalItems, 1);
      assert.deepEqual(
        evaluatedView.workViewEvaluation.rows.map((row) => row.id),
        [created.workItem.id],
      );
      assert.deepEqual(
        evaluatedView.workViewEvaluation.pages.map((page) => page.id),
        [createdPage.workPage.id],
      );
      assert.ok(
        evaluatedView.workViewEvaluation.columns.some(
          (column) => column.id === "in_progress" && column.count === 1,
        ),
      );
      assert.equal(inlineViewEvaluationResponse.status, 200);
      assert.equal(
        inlineEvaluatedView.workViewEvaluation.view.title,
        "Inline docs view",
      );
      assert.deepEqual(
        inlineEvaluatedView.workViewEvaluation.rows.map((row) => row.id),
        [created.workItem.id],
      );
      assert.equal(viewTransitionResponse.status, 200);
      assert.equal(transitionedView.workView.state, "archived");
      assert.equal(pageTransitionResponse.status, 200);
      assert.equal(transitionedPage.workPage.state, "archived");
      assert.equal(
        transitionedPage.workPage.metadata.transitions[0].reason,
        "plan moved into runbook",
      );
      assert.equal(searchResponse.status, 200);
      assert.equal(searched.search.results[0].kind, "work_item");
      assert.equal(searched.search.results[0].id, created.workItem.id);
      assert.equal(planningSearchResponse.status, 200);
      assert.ok(
        planningSearch.search.results.some(
          (result) => result.kind === "work_cycle",
        ),
      );
      assert.ok(
        planningSearch.search.results.some(
          (result) => result.kind === "work_module",
        ),
      );
      assert.ok(
        planningSearch.search.results.some(
          (result) => result.kind === "work_view",
        ),
      );
      assert.ok(
        planningSearch.search.results.some(
          (result) => result.kind === "work_page",
        ),
      );
      assert.equal(pageSearchResponse.status, 200);
      assert.equal(pageSearch.search.results[0].kind, "work_page");
      assert.equal(pageSearch.search.results[0].id, createdPage.workPage.id);
    });
  });

  it("serves work intake previews and applies confirmed queue-to-work automation", async () => {
    const intakeConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(intakeConfig, async (intakeBaseUrl, intakeStore) => {
      await intakeStore.upsertQueueItem(
        readyItem({
          pullRequestId: 861,
          queueState: "ready",
          title: "Automate board intake",
          ownerAgentId: "agent-planner",
          changedFiles: ["packages/planner/src/intake.ts"],
          affectedPackages: ["planner"],
        }),
      );

      const previewResponse = await fetch(
        `${intakeBaseUrl}/api/work-intake?repo=elizaos/eliza&now=2026-07-07T10%3A00%3A00.000Z`,
      );
      const preview = await previewResponse.json();

      const rejectedApplyResponse = await fetch(
        `${intakeBaseUrl}/api/work-intake/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repo: "elizaos/eliza",
          }),
        },
      );
      const rejectedApply = await rejectedApplyResponse.json();

      const applyResponse = await fetch(
        `${intakeBaseUrl}/api/work-intake/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirm: true,
            repo: "elizaos/eliza",
            actorId: "agent-planner",
            now: "2026-07-07T10:01:00.000Z",
          }),
        },
      );
      const applied = await applyResponse.json();

      const workItemResponse = await fetch(
        `${intakeBaseUrl}/api/work-items/item?id=${encodeURIComponent("work:elizaos/eliza:pr:861")}`,
      );
      const workItem = await workItemResponse.json();

      const secondPreviewResponse = await fetch(
        `${intakeBaseUrl}/api/work-intake?repo=elizaos/eliza&now=2026-07-07T10%3A02%3A00.000Z`,
      );
      const secondPreview = await secondPreviewResponse.json();

      assert.equal(previewResponse.status, 200);
      assert.equal(preview.workIntake.summary.creates, 1);
      assert.equal(preview.workIntake.actions[0].type, "create_work_item");
      assert.equal(
        preview.workIntake.actions[0].targetWorkItem.id,
        "work:elizaos/eliza:pr:861",
      );
      assert.equal(rejectedApplyResponse.status, 400);
      assert.equal(rejectedApply.error, "confirmation_required");
      assert.equal(applyResponse.status, 200);
      assert.equal(applied.workIntake.applied.count, 1);
      assert.equal(
        applied.workIntake.applied.actions[0].workItemId,
        "work:elizaos/eliza:pr:861",
      );
      assert.equal(workItemResponse.status, 200);
      assert.equal(workItem.workItem.ownerAgentId, "agent-planner");
      assert.deepEqual(workItem.workItem.packages, ["planner"]);
      assert.equal(secondPreviewResponse.status, 200);
      assert.equal(secondPreview.workIntake.summary.unchanged, 1);
      assert.equal(secondPreview.workIntake.actions[0].type, "noop");
    });
  });

  it("serves CI failure analysis for agent routing", async () => {
    const ciConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(ciConfig, async (ciBaseUrl, ciStore) => {
      await ciStore.upsertQueueItem(
        readyItem({
          pullRequestId: 891,
          queueState: "blocked_checks",
          ownerAgentId: "agent-ci-runtime",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
          requiredChecks: ["unit"],
          checkResults: { unit: "failure" },
        }),
      );

      const response = await fetch(`${ciBaseUrl}/api/ci/failure-analysis`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "elizaos/eliza#891",
          now: "2026-07-06T00:00:00.000Z",
          checks: [
            {
              name: "unit",
              conclusion: "failure",
              log: "FAIL runtime.test.ts\nAssertionError: Expected 1 Received 0",
            },
          ],
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.analysis.queueItem.id, "elizaos/eliza#891");
      assert.equal(body.analysis.summary.primaryCategory, "test_failure");
      assert.equal(
        body.analysis.analyses[0].likelyOwnerAgentId,
        "agent-ci-runtime",
      );
      assert.deepEqual(body.analysis.analyses[0].impact.packages, ["core"]);
      assert.equal(
        body.analysis.recommendations[0].action,
        "inspect_failed_test",
      );
    });
  });

  it("serves CI validation plans for agent runner budgeting", async () => {
    const response = await fetch(`${baseUrl}/api/ci/validation-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "elizaos/eliza",
        changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
        affectedPackages: ["plugin-capacitor-bridge"],
        commands: ["turbo run typecheck"],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.validationPlan.decision.allowed, false);
    assert.ok(
      body.validationPlan.decision.blockers.includes(
        "broad_validation_commands",
      ),
    );
    assert.equal(body.validationPlan.commands[0].scope, "broad");
    assert.equal(
      body.validationPlan.recommendedCommands[0].command,
      "turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge",
    );
  });

  it("serves PR review briefs for agent handoff", async () => {
    const briefConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(briefConfig, async (briefBaseUrl, briefStore) => {
      await briefStore.upsertQueueItem(
        readyItem({
          pullRequestId: 892,
          queueState: "blocked_checks",
          ownerAgentId: "agent-ci-runtime",
          hasValidationPlan: false,
          reviewSatisfied: false,
          changedLines: 980,
          changedFiles: [
            "packages/core/src/runtime.ts",
            ".forgejo/workflows/merge-steward.yml",
          ],
          affectedPackages: ["core"],
          requiredChecks: ["unit"],
          checkResults: { unit: "failure" },
        }),
      );

      const response = await fetch(`${briefBaseUrl}/api/pr/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "elizaos/eliza#892",
          now: "2026-07-06T00:00:00.000Z",
          ciAnalysis: {
            summary: {
              failedLogs: 1,
              primaryCategory: "test_failure",
              maxSeverity: "high",
              retryable: false,
              nextAction: "inspect_failed_test",
            },
          },
          validationCommands: ["turbo run typecheck"],
          requireWorkReservation: true,
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.brief.id, "elizaos/eliza#892");
      assert.equal(body.brief.ownerAgentId, "agent-ci-runtime");
      assert.equal(body.brief.review.required, true);
      assert.equal(body.brief.review.reason, "validation_budget_blocked");
      assert.ok(body.brief.summary.includes("elizaos/eliza #892"));
      assert.ok(body.brief.risk.areas.some((area) => area.kind === "workflow"));
      assert.ok(body.brief.verification.missing.includes("ci_failure_triage"));
      assert.ok(
        body.brief.verification.missing.includes("scoped_validation_budget"),
      );
      assert.ok(body.brief.verification.missing.includes("work_reservation"));
      assert.equal(body.brief.validationBudget.state, "blocked");
      assert.equal(body.brief.workReservation.state, "blocked");
      assert.deepEqual(body.brief.workReservation.missingFiles, [
        "packages/core/src/runtime.ts",
        ".forgejo/workflows/merge-steward.yml",
      ]);
      assert.deepEqual(body.brief.workReservation.missingPackages, ["core"]);
      assert.equal(
        body.brief.validationBudget.recommendedCommands[0].command,
        "turbo run typecheck --filter=@elizaos/core",
      );
      assert.ok(body.brief.labels.includes("needs-human"));
      assert.ok(body.brief.labels.includes("validation:broad-blocked"));
      assert.ok(body.brief.labels.includes("reservation:missing"));
    });
  });

  it("predicts proposed patch conflicts before PR creation", async () => {
    const conflictConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(conflictConfig, async (conflictBaseUrl, conflictStore) => {
      await conflictStore.upsertQueueItem(
        readyItem({
          pullRequestId: 898,
          queueState: "ready",
          ownerAgentId: "agent-ci-runtime",
          targetBranch: "develop",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
        }),
      );
      await conflictStore.claimAgentWork(
        {
          repo: "elizaos/eliza",
          resourceKind: "path",
          resourceId: "packages/core/src/db/migrations/002.sql",
          ownerAgentId: "agent-db",
        },
        {
          now: "2026-07-06T00:00:00.000Z",
          ttlMs: 30 * 60 * 1000,
        },
      );

      const response = await fetch(
        `${conflictBaseUrl}/api/patch/conflict-prediction`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repo: "elizaos/eliza",
            targetBranch: "develop",
            ownerAgentId: "agent-runtime",
            now: "2026-07-06T00:10:00.000Z",
            changedFiles: [
              "packages/core/src/runtime.ts",
              "packages/core/src/db/migrations/002.sql",
            ],
            affectedPackages: ["core"],
          }),
        },
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.prediction.repo, "elizaos/eliza");
      assert.equal(body.prediction.prediction.state, "blocked");
      assert.equal(body.prediction.prediction.safeToStart, false);
      assert.ok(
        body.prediction.prediction.blockers.includes("same_file_open_pr"),
      );
      assert.ok(
        body.prediction.prediction.blockers.includes("active_claim_conflict"),
      );
      assert.equal(body.prediction.overlaps.queueItems[0].pullRequestId, 898);
      assert.equal(body.prediction.overlaps.claims[0].ownerAgentId, "agent-db");
      assert.ok(body.prediction.labels.includes("patch-conflict:blocked"));
    });
  });

  it("serves review assignment suggestions for agent PR handoff", async () => {
    const assignmentConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      assignmentConfig,
      async (assignmentBaseUrl, assignmentStore) => {
        await assignmentStore.upsertRegisteredAgent(
          {
            id: "agent-author",
            metadata: {
              reviewPackages: ["core"],
            },
          },
          { registeredBy: "admin-one", now: "2026-07-06T00:00:00.000Z" },
        );
        await assignmentStore.upsertRegisteredAgent(
          {
            id: "agent-core",
            displayName: "Core Agent",
            metadata: {
              reviewPackages: ["core"],
              reviewPaths: ["packages/core/**"],
            },
          },
          { registeredBy: "admin-one", now: "2026-07-06T00:00:00.000Z" },
        );
        await assignmentStore.upsertQueueItem(
          readyItem({
            pullRequestId: 899,
            queueState: "ready",
            ownerAgentId: "agent-core",
            targetBranch: "develop",
            changedFiles: ["packages/core/src/runtime.ts"],
            affectedPackages: ["core"],
          }),
        );

        const response = await fetch(
          `${assignmentBaseUrl}/api/review/assignment`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              ownerAgentId: "agent-author",
              changedFiles: [
                "packages/core/src/runtime.ts",
                "packages/core/src/db/migrations/002.sql",
              ],
              affectedPackages: ["core"],
              now: "2026-07-06T00:10:00.000Z",
            }),
          },
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.assignment.repo, "elizaos/eliza");
        assert.equal(body.assignment.decision.state, "needs_human_review");
        assert.equal(
          body.assignment.suggestedReviewers[0].agentId,
          "agent-core",
        );
        assert.ok(
          body.assignment.excludedCandidates.some(
            (candidate) =>
              candidate.agentId === "agent-author" &&
              candidate.reason === "author_agent",
          ),
        );
        assert.ok(
          body.assignment.humanReviewHints.some(
            (hint) => hint.id === "maintainer:database",
          ),
        );
        assert.ok(
          body.assignment.labels.includes(
            "review-assignment:needs_human_review",
          ),
        );
      },
    );
  });

  it("serves release notes from merged queue items", async () => {
    const notesConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(notesConfig, async (notesBaseUrl, notesStore) => {
      await notesStore.upsertQueueItem(
        readyItem({
          pullRequestId: 901,
          title: "feat: add agent release summaries",
          queueState: "merged",
          pullRequestMerged: true,
          mergedAt: "2026-07-06T10:00:00.000Z",
          ownerAgentId: "agent-docs",
          affectedPackages: ["core"],
          labels: ["feature"],
          commitSummary:
            "Adds deterministic release-note grouping for merged agent PRs.",
        }),
      );
      await notesStore.upsertQueueItem(
        readyItem({
          pullRequestId: 902,
          title: "fix: repair release filter",
          queueState: "merged",
          pullRequestMerged: true,
          mergedAt: "2026-07-06T11:00:00.000Z",
          ownerAgentId: "agent-runtime",
          affectedPackages: ["server"],
          labels: ["bug"],
        }),
      );
      await notesStore.upsertQueueItem(
        readyItem({
          pullRequestId: 903,
          title: "feat: open follow-up",
          queueState: "ready",
          pullRequestMerged: false,
          ownerAgentId: "agent-docs",
          affectedPackages: ["core"],
          labels: ["feature"],
        }),
      );

      const response = await fetch(
        `${notesBaseUrl}/api/releases/notes?repo=elizaos%2Feliza&targetBranch=develop&version=2.1.0&now=2026-07-07T00%3A00%3A00.000Z`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.notes.title, "Release 2.1.0");
      assert.equal(body.notes.summary.totalMergedPullRequests, 2);
      assert.equal(body.notes.summary.agentPullRequests, 2);
      assert.deepEqual(
        body.notes.sections.map((section) => section.key),
        ["features", "fixes"],
      );
      assert.deepEqual(
        body.notes.validation.excluded.map((item) => item.reason),
        ["not_merged"],
      );
      assert.ok(
        body.notes.markdown.includes(
          "feat: add agent release summaries (#901)",
        ),
      );
      assert.ok(body.notes.markdown.includes("agent-docs"));
    });
  });

  it("lets an agent claim a suggested assignment", async () => {
    const assignmentConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      assignmentConfig,
      async (assignmentBaseUrl, assignmentStore) => {
        await assignmentStore.upsertQueueItem(
          readyItem({
            pullRequestId: 861,
            queueState: "ready",
            priority: 10,
            ownerAgentId: "agent-assignment-core",
            changedFiles: ["packages/core/src/runtime.ts"],
            affectedPackages: ["core"],
            requiredChecks: ["unit"],
            checkResults: { unit: "failure" },
          }),
        );
        await assignmentStore.upsertQueueItem(
          readyItem({
            pullRequestId: 862,
            queueState: "ready",
            priority: 9,
            ownerAgentId: "agent-assignment-ui",
            changedFiles: ["packages/client/src/chat.ts"],
            affectedPackages: ["client"],
          }),
        );
        await assignmentStore.upsertQueueItem(
          readyItem({
            pullRequestId: 863,
            queueState: "ready",
            priority: 8,
            ownerAgentId: null,
            changedFiles: ["packages/core/src/memory.ts"],
            affectedPackages: ["core"],
          }),
        );

        const dryRunResponse = await fetch(
          `${assignmentBaseUrl}/api/agents/agent-assignment-ui/claim-assignment`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              now: "2026-07-06T00:10:00.000Z",
              dryRun: true,
            }),
          },
        );
        const dryRunBody = await dryRunResponse.json();
        const claimResponse = await fetch(
          `${assignmentBaseUrl}/api/agents/agent-assignment-ui/claim-assignment`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo: "elizaos/eliza",
              targetBranch: "develop",
              ttlMs: 60_000,
              now: "2026-07-06T00:10:00.000Z",
            }),
          },
        );
        const claimBody = await claimResponse.json();
        const listResponse = await fetch(
          `${assignmentBaseUrl}/api/claims?ownerAgentId=agent-assignment-ui&status=active`,
        );
        const listBody = await listResponse.json();

        assert.equal(dryRunResponse.status, 200);
        assert.equal(dryRunBody.dryRun, true);
        assert.equal(dryRunBody.suggestion.itemId, "elizaos/eliza#863");
        assert.equal(
          dryRunBody.claim.metadata.source,
          "agent-capacity-assignment",
        );
        assert.equal(claimResponse.status, 200);
        assert.equal(claimBody.claimed, true);
        assert.equal(claimBody.claim.resourceKind, "pull_request");
        assert.equal(claimBody.claim.resourceId, "863");
        assert.equal(claimBody.claim.expiresAt, "2026-07-06T00:11:00.000Z");
        assert.equal(listBody.claims.length, 1);
        assert.equal(
          listBody.claims[0].metadata.suggestionId,
          claimBody.suggestion.id,
        );
      },
    );
  });

  it("resumes waiting runs when a matching signal arrives", async () => {
    const signalConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(signalConfig, async (signalBaseUrl) => {
      await fetch(`${signalBaseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "run-waiting-signal",
          queueItemId: "elizaos/eliza#551",
          status: "waiting_event",
          correlationKey: "checks:head-sha",
        }),
      });
      await fetch(`${signalBaseUrl}/api/runs/run-waiting-signal/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: "required_checks",
          status: "waiting_event",
          correlationKey: "checks:head-sha",
        }),
      });

      const signalResponse = await fetch(`${signalBaseUrl}/api/signals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          correlationKey: "checks:head-sha",
          type: "checks.passed",
          payload: { sha: "head-sha" },
        }),
      });
      const signalBody = await signalResponse.json();
      const runStateResponse = await fetch(
        `${signalBaseUrl}/api/runs/run-waiting-signal/run-state`,
      );
      const runStateBody = await runStateResponse.json();
      const nodesResponse = await fetch(
        `${signalBaseUrl}/api/runs/run-waiting-signal/nodes`,
      );
      const nodesBody = await nodesResponse.json();
      const eventsResponse = await fetch(
        `${signalBaseUrl}/api/runs/run-waiting-signal/events`,
      );
      const eventsBody = await eventsResponse.json();
      const consumedSignalsResponse = await fetch(
        `${signalBaseUrl}/api/signals?correlationKey=checks%3Ahead-sha&status=consumed`,
      );
      const consumedSignalsBody = await consumedSignalsResponse.json();

      assert.equal(signalResponse.status, 200);
      assert.equal(signalBody.signal.status, "consumed");
      assert.equal(signalBody.resumedRuns.length, 1);
      assert.equal(signalBody.resumedRuns[0].status, "running");
      assert.equal(runStateBody.runState.state, "running");
      assert.equal(nodesResponse.status, 200);
      assert.equal(nodesBody.nodes[0].status, "succeeded");
      assert.equal(
        nodesBody.nodes[0].completedBySignalId,
        signalBody.signal.id,
      );
      assert.equal(eventsResponse.status, 200);
      assert.equal(eventsBody.events[0].type, "SignalReceived");
      assert.equal(consumedSignalsResponse.status, 200);
      assert.equal(consumedSignalsBody.signals.length, 1);
    });
  });

  it("serves steward run lifecycle endpoints", async () => {
    const runConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(runConfig, async (runBaseUrl) => {
      const createRunResponse = await fetch(`${runBaseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "elizaos/eliza#601",
          repo: "elizaos/eliza",
          pullRequestId: 601,
          status: "waiting_approval",
        }),
      });
      const createRunBody = await createRunResponse.json();
      const runId = createRunBody.run.id;
      const nodeResponse = await fetch(
        `${runBaseUrl}/api/runs/${encodeURIComponent(runId)}/nodes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nodeId: "human_approval",
            status: "waiting_approval",
          }),
        },
      );
      const eventResponse = await fetch(
        `${runBaseUrl}/api/runs/${encodeURIComponent(runId)}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "ApprovalRequested",
            payload: { reason: "sensitive path" },
          }),
        },
      );
      const secondEventResponse = await fetch(
        `${runBaseUrl}/api/runs/${encodeURIComponent(runId)}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "NodeFinished",
          }),
        },
      );
      const runStateResponse = await fetch(
        `${runBaseUrl}/api/runs/${encodeURIComponent(runId)}/run-state`,
      );
      const runStateBody = await runStateResponse.json();
      const listRunsResponse = await fetch(
        `${runBaseUrl}/api/runs?status=waiting_approval`,
      );
      const listRunsBody = await listRunsResponse.json();
      const listEventsResponse = await fetch(
        `${runBaseUrl}/api/runs/${encodeURIComponent(runId)}/events`,
      );
      const listEventsBody = await listEventsResponse.json();
      const listEventsAfterSeqResponse = await fetch(
        `${runBaseUrl}/api/runs/${encodeURIComponent(runId)}/events?afterSeq=1`,
      );
      const listEventsAfterSeqBody = await listEventsAfterSeqResponse.json();

      assert.equal(createRunResponse.status, 200);
      assert.equal(runId, "run:elizaos/eliza#601");
      assert.equal(nodeResponse.status, 200);
      assert.equal(eventResponse.status, 200);
      assert.equal(secondEventResponse.status, 200);
      assert.equal(runStateResponse.status, 200);
      assert.equal(runStateBody.runState.state, "waiting-approval");
      assert.equal(runStateBody.runState.blocked.nodeId, "human_approval");
      assert.equal(listRunsResponse.status, 200);
      assert.equal(listRunsBody.runs.length, 1);
      assert.equal(listEventsResponse.status, 200);
      assert.equal(listEventsBody.events[0].type, "ApprovalRequested");
      assert.equal(listEventsBody.events[0].seq, 1);
      assert.equal(listEventsAfterSeqResponse.status, 200);
      assert.equal(listEventsAfterSeqBody.events.length, 1);
      assert.equal(listEventsAfterSeqBody.events[0].type, "NodeFinished");
    });
  });

  it("serves steward attempt lifecycle and recovery endpoints", async () => {
    const runConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(runConfig, async (runBaseUrl) => {
      const createRunResponse = await fetch(`${runBaseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "run-attempt-one",
          queueItemId: "elizaos/eliza#701",
          status: "running",
        }),
      });
      const missingRunAttemptResponse = await fetch(
        `${runBaseUrl}/api/runs/missing-run/attempts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId: "checks", ownerId: "worker-a" }),
        },
      );
      const createAttemptResponse = await fetch(
        `${runBaseUrl}/api/runs/run-attempt-one/attempts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nodeId: "checks",
            ownerId: "worker-a",
            heartbeatAt: "2026-07-06T00:00:00.000Z",
          }),
        },
      );
      const createAttemptBody = await createAttemptResponse.json();
      const attemptId = createAttemptBody.attempt.id;
      const itemResponse = await fetch(
        `${runBaseUrl}/api/attempts/item?id=${encodeURIComponent(attemptId)}`,
      );
      const wrongOwnerHeartbeatResponse = await fetch(
        `${runBaseUrl}/api/attempts/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: attemptId, ownerId: "worker-b" }),
        },
      );
      const claimStaleResponse = await fetch(
        `${runBaseUrl}/api/attempts/claim-stale`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workerId: "worker-b",
            now: "2026-07-06T00:01:00.000Z",
            staleAfterMs: 30_000,
          }),
        },
      );
      const claimStaleBody = await claimStaleResponse.json();
      const heartbeatResponse = await fetch(
        `${runBaseUrl}/api/attempts/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: attemptId, ownerId: "worker-b" }),
        },
      );
      const finishResponse = await fetch(`${runBaseUrl}/api/attempts/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: attemptId, output: { merged: false } }),
      });
      const secondAttemptResponse = await fetch(
        `${runBaseUrl}/api/runs/run-attempt-one/attempts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId: "checks", ownerId: "worker-c" }),
        },
      );
      const secondAttemptBody = await secondAttemptResponse.json();
      const failResponse = await fetch(`${runBaseUrl}/api/attempts/fail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: secondAttemptBody.attempt.id,
          error: "checks failed",
          retryAfterMs: 60_000,
        }),
      });
      const failBody = await failResponse.json();
      const thirdAttemptResponse = await fetch(
        `${runBaseUrl}/api/runs/run-attempt-one/attempts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId: "checks", ownerId: "worker-d" }),
        },
      );
      const thirdAttemptBody = await thirdAttemptResponse.json();
      const cancelResponse = await fetch(`${runBaseUrl}/api/attempts/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: thirdAttemptBody.attempt.id,
          reason: "superseded",
          cancelledBy: "operator-one",
        }),
      });
      const listResponse = await fetch(
        `${runBaseUrl}/api/runs/run-attempt-one/attempts?nodeId=checks`,
      );
      const listBody = await listResponse.json();

      assert.equal(createRunResponse.status, 200);
      assert.equal(missingRunAttemptResponse.status, 404);
      assert.equal(createAttemptResponse.status, 200);
      assert.equal(attemptId, "attempt:run-attempt-one:checks:1");
      assert.equal(itemResponse.status, 200);
      assert.equal(wrongOwnerHeartbeatResponse.status, 404);
      assert.equal(claimStaleResponse.status, 200);
      assert.equal(claimStaleBody.claimed, true);
      assert.equal(claimStaleBody.attempt.ownerId, "worker-b");
      assert.equal(heartbeatResponse.status, 200);
      assert.equal(finishResponse.status, 200);
      assert.equal(
        secondAttemptBody.attempt.id,
        "attempt:run-attempt-one:checks:2",
      );
      assert.equal(failResponse.status, 200);
      assert.equal(failBody.attempt.status, "failed");
      assert.equal(cancelResponse.status, 200);
      assert.equal(listResponse.status, 200);
      assert.equal(listBody.attempts.length, 3);
    });
  });

  it("rejects run child writes when the run does not exist", async () => {
    const runConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(runConfig, async (runBaseUrl) => {
      const response = await fetch(
        `${runBaseUrl}/api/runs/${encodeURIComponent("missing-run")}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "NodeFinished" }),
        },
      );
      const body = await response.json();

      assert.equal(response.status, 404);
      assert.equal(body.error, "run_not_found");
    });
  });

  it("claims finishes and fails persisted queue items through the control API", async () => {
    const claimConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(claimConfig, async (claimBaseUrl, claimStore) => {
      await claimStore.upsertQueueItem(
        readyItem({
          repo: "elizaos/runtime",
          pullRequestId: 401,
          priority: 10,
        }),
      );
      await claimStore.upsertQueueItem(
        readyItem({ repo: "elizaos/runtime", pullRequestId: 403, priority: 9 }),
      );

      const claimResponse = await fetch(`${claimBaseUrl}/api/queue/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "api-worker" }),
      });
      const claimBody = await claimResponse.json();
      const blockedResponse = await fetch(`${claimBaseUrl}/api/queue/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "api-worker-two" }),
      });
      const blockedBody = await blockedResponse.json();
      const finishResponse = await fetch(
        `${claimBaseUrl}/api/queue/item/finish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "elizaos/runtime#401", state: "merged" }),
        },
      );
      const finishBody = await finishResponse.json();

      await claimStore.upsertQueueItem(
        readyItem({ repo: "elizaos/cloud", pullRequestId: 402, priority: 10 }),
      );
      const secondClaimResponse = await fetch(
        `${claimBaseUrl}/api/queue/claim`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerId: "api-worker-three" }),
        },
      );
      const secondClaimBody = await secondClaimResponse.json();
      const failResponse = await fetch(`${claimBaseUrl}/api/queue/item/fail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "elizaos/cloud#402",
          error: "integration checks failed",
        }),
      });
      const failBody = await failResponse.json();

      await claimStore.upsertQueueItem(
        readyItem({
          repo: "elizaos/cloud",
          pullRequestId: 404,
          hasExecutionPlan: false,
        }),
      );
      const malformedOverrideResponse = await fetch(
        `${claimBaseUrl}/api/queue/item/override`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "elizaos/cloud#404",
            reason: "missing actor",
          }),
        },
      );
      const malformedOverrideBody = await malformedOverrideResponse.json();
      const overrideResponse = await fetch(
        `${claimBaseUrl}/api/queue/item/override`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "elizaos/cloud#404",
            approvedBy: "operator-one",
            reason: "approved small scoped agent fix",
            blockers: ["missing_agent_plan"],
            now: "2026-07-06T00:00:00.000Z",
          }),
        },
      );
      const overrideBody = await overrideResponse.json();
      const clearOverrideResponse = await fetch(
        `${claimBaseUrl}/api/queue/item/override/clear`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "elizaos/cloud#404",
            clearedBy: "operator-one",
            reason: "override expired",
            now: "2026-07-06T00:05:00.000Z",
          }),
        },
      );
      const clearOverrideBody = await clearOverrideResponse.json();
      const auditEvents = await claimStore.listEvents();

      assert.equal(claimResponse.status, 200);
      assert.equal(claimBody.claimed, true);
      assert.equal(claimBody.item.id, "elizaos/runtime#401");
      assert.equal(claimBody.item.claimedBy, "api-worker");
      assert.equal(blockedResponse.status, 200);
      assert.equal(blockedBody.claimed, false);
      assert.equal(blockedBody.reason, "repo_or_target_busy");
      assert.equal(finishResponse.status, 200);
      assert.equal(finishBody.item.queueState, "merged");
      assert.equal(secondClaimResponse.status, 200);
      assert.equal(secondClaimBody.claimed, true);
      assert.equal(secondClaimBody.item.id, "elizaos/cloud#402");
      assert.equal(failResponse.status, 200);
      assert.equal(failBody.item.queueState, "failed");
      assert.equal(failBody.item.lastError, "integration checks failed");
      assert.equal(malformedOverrideResponse.status, 400);
      assert.equal(malformedOverrideBody.error, "missing_override_approval");
      assert.equal(overrideResponse.status, 200);
      assert.equal(overrideBody.decision.allowed, true);
      assert.deepEqual(
        overrideBody.decision.policyOverride.overriddenBlockers,
        ["missing_agent_plan"],
      );
      assert.equal(overrideBody.item.policyOverride.approvedBy, "operator-one");
      assert.equal(clearOverrideResponse.status, 200);
      assert.equal(clearOverrideBody.decision.allowed, false);
      assert.deepEqual(clearOverrideBody.decision.blockers, [
        "missing_agent_plan",
      ]);
      assert.equal(clearOverrideBody.item.policyOverride.active, false);
      assert.deepEqual(
        auditEvents.map((event) => event.type),
        ["queue.PolicyOverrideApplied", "queue.PolicyOverrideCleared"],
      );
    });
  });

  it("serves computed queue item run state", async () => {
    const runStateConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(runStateConfig, async (runStateBaseUrl, runStateStore) => {
      await runStateStore.upsertQueueItem(
        readyItem({
          repo: "elizaos/runtime",
          pullRequestId: 501,
          queueState: "waiting_for_checks",
          headSha: "head-sha-501",
        }),
      );

      const response = await fetch(
        `${runStateBaseUrl}/api/queue/item/run-state?id=${encodeURIComponent("elizaos/runtime#501")}`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.runState.state, "waiting-event");
      assert.equal(body.runState.blocked.kind, "event");
      assert.equal(body.runState.blocked.correlationKey, "head-sha-501");
    });
  });

  it("serves a PR-scoped queue item action plan", async () => {
    const actionPlanConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });

    await withServer(
      actionPlanConfig,
      async (actionPlanBaseUrl, actionPlanStore) => {
        await actionPlanStore.upsertQueueItem(
          readyItem({
            repo: "elizaos/runtime",
            pullRequestId: 502,
            queueState: "waiting_for_review",
            ownerAgentId: "agent-queue-plan",
            targetBranch: "develop",
            priority: 20,
          }),
        );
        await actionPlanStore.upsertApproval({
          id: "approval-queue-plan",
          queueItemId: "elizaos/runtime#502",
          status: "requested",
        });

        const response = await fetch(
          `${actionPlanBaseUrl}/api/queue/item/action-plan?id=${encodeURIComponent("elizaos/runtime#502")}&ownerAgentId=agent-queue-plan&readiness=false&now=2026-07-07T02%3A00%3A00.000Z`,
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.queueItemActionPlan.readOnly, true);
        assert.equal(body.queueItemActionPlan.item.id, "elizaos/runtime#502");
        assert.equal(
          body.queueItemActionPlan.item.ownerAgentId,
          "agent-queue-plan",
        );
        assert.equal(body.queueItemActionPlan.workflow.status, "needs-human");
        assert.equal(
          body.queueItemActionPlan.nextSteps[0].id,
          "decide_approval",
        );
        assert.equal(
          body.queueItemActionPlan.links.agentCockpit,
          "/api/agents/agent-queue-plan/cockpit?repo=elizaos%2Fruntime&targetBranch=develop",
        );
        assert.equal(
          body.queueItemActionPlan.snapshots.queueSummaryItem.id,
          "elizaos/runtime#502",
        );
      },
    );
  });

  it("does not execute caller-supplied queue facts in live mode", async () => {
    const liveConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });

    await withServer(liveConfig, async (liveBaseUrl) => {
      const response = await fetch(
        `${liveBaseUrl}/api/queue/integration-execution`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirm: true,
            items: [
              {
                repo: "elizaos/eliza",
                pullRequestId: 88,
                sourceBranch: "agent/change",
                targetBranch: "develop",
                headSha: "head-sha-88",
                authorKind: "agent",
                ownerAgentId: "agent-one",
                agentKnown: true,
                hasIssueLink: true,
                hasExecutionPlan: true,
                hasValidationPlan: true,
                targetProtected: true,
                reviewSatisfied: true,
                headShaMatches: true,
                changedFiles: ["README.md"],
                requiredChecks: ["smoke"],
                checkResults: { smoke: "success" },
              },
            ],
          }),
        },
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.plan.planCount, 0);
      assert.equal(body.execution.skipped, true);
      assert.equal(body.execution.reason, "no_ready_items");
    });
  });

  it("serves durable queue run-once execution", async () => {
    const runOnceConfig = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    });

    await withServer(runOnceConfig, async (runOnceBaseUrl, runOnceStore) => {
      await runOnceStore.upsertQueueItem(
        readyItem({ repo: "elizaos/runtime", pullRequestId: 601 }),
      );

      const response = await fetch(`${runOnceBaseUrl}/api/queue/run-once`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "api-worker", confirm: true }),
      });
      const body = await response.json();
      const runs = await runOnceStore.listRuns({
        queueItemId: "elizaos/runtime#601",
      });
      const attempts = await runOnceStore.listAttempts({ runId: body.run.id });

      assert.equal(response.status, 200);
      assert.equal(body.claimed, true);
      assert.equal(body.item.queueState, "failed");
      assert.equal(body.item.lastError, "integration_executor_unconfigured");
      assert.equal(body.run.status, "failed");
      assert.equal(runs.length, 1);
      assert.equal(attempts[0].status, "failed");
    });
  });

  it("accepts a signed Forgejo pull request webhook and stores a queue item", async () => {
    const rawBody = JSON.stringify(pullRequestPayload());
    const response = await fetch(`${baseUrl}/api/webhooks/forgejo`, {
      method: "POST",
      headers: signedHeaders(rawBody, {
        "content-type": "application/json",
        "x-forgejo-delivery": "delivery-pr-12",
        "x-forgejo-event": "pull_request",
      }),
      body: rawBody,
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.accepted, true);
    assert.equal(body.item.id, "elizaos/eliza#12");
    assert.equal(body.item.authorKind, "agent");
    assert.equal(body.item.ownerAgentId, "agent-one");
    assert.deepEqual(body.item.labels, ["queue:ready", "agent:agent-one"]);
    assert.equal(body.decision.allowed, false);
    assert.match(body.comment, /Eliza Merge Steward/);

    const queueResponse = await fetch(`${baseUrl}/api/queue`);
    const queueBody = await queueResponse.json();
    assert.equal(queueResponse.status, 200);
    assert.equal(queueBody.items.length, 1);
    assert.equal(queueBody.items[0].id, "elizaos/eliza#12");

    const itemResponse = await fetch(
      `${baseUrl}/api/queue/item?id=${encodeURIComponent("elizaos/eliza#12")}`,
    );
    const itemBody = await itemResponse.json();
    assert.equal(itemResponse.status, 200);
    assert.equal(itemBody.item.headSha, "head-sha-12");
  });

  it("enriches an existing queue item from a signed status webhook", async () => {
    await store.upsertQueueItem({
      repo: "elizaos/eliza",
      pullRequestId: 12,
      headSha: "head-sha-12",
      labels: ["queue:ready", "agent:agent-one"],
    });
    const rawBody = JSON.stringify({
      id: 50,
      sha: "head-sha-12",
      state: "success",
      context: "smoke",
      repository: baseRepository,
      sender: { login: "forgejo-actions" },
    });
    const response = await fetch(`${baseUrl}/api/webhooks/forgejo`, {
      method: "POST",
      headers: signedHeaders(rawBody, {
        "content-type": "application/json",
        "x-forgejo-delivery": "delivery-status-12",
        "x-forgejo-event": "status",
      }),
      body: rawBody,
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.accepted, true);
    assert.equal(body.item.id, "elizaos/eliza#12");
    assert.deepEqual(body.item.requiredChecks, ["smoke"]);
    assert.equal(body.item.checkResults.smoke, "success");
  });

  it("rejects Forgejo webhooks with invalid signatures", async () => {
    const rawBody = JSON.stringify(pullRequestPayload({ number: 13 }));
    const response = await fetch(`${baseUrl}/api/webhooks/forgejo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forgejo-event": "pull_request",
        "x-forgejo-signature": "0".repeat(64),
      },
      body: rawBody,
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error, "bad_request");
    assert.match(body.message, /signature/i);
  });

  it("rejects malformed JSON bodies with a typed 400", async () => {
    const response = await fetch(`${baseUrl}/api/comments/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "bad_request");
    assert.equal(body.message, "invalid_json_body");
  });

  it("maps internal failures to an opaque 500 without leaking details", async () => {
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });
    const brokenStore = new InMemoryQueueStore();
    brokenStore.listQueueItems = async () => {
      throw new Error("secret internal detail");
    };
    const brokenServer = createServer({
      config,
      logger: silentLogger,
      steward: new MergeSteward({
        config,
        store: brokenStore,
        logger: silentLogger,
      }),
    });
    await new Promise((resolve) =>
      brokenServer.listen(0, "127.0.0.1", resolve),
    );
    const address = brokenServer.address();

    try {
      const response = await fetch(
        `http://${address.address}:${address.port}/api/queue`,
      );
      const text = await response.text();

      assert.equal(response.status, 500);
      assert.deepEqual(JSON.parse(text), { error: "internal_error" });
      assert.ok(!text.includes("secret internal detail"));
    } finally {
      await new Promise((resolve, reject) => {
        brokenServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

const silentLogger = Object.freeze({
  error() {},
  info() {},
});

const WEBHOOK_SECRET = "local-server-webhook-secret";

const baseRepository = Object.freeze({
  id: 42,
  name: "eliza",
  full_name: "elizaos/eliza",
  private: true,
  default_branch: "develop",
  owner: {
    id: 7,
    login: "elizaos",
    username: "elizaos",
  },
});

function pullRequestPayload({ number = 12 } = {}) {
  return {
    action: "opened",
    number,
    repository: baseRepository,
    pull_request: {
      id: 99,
      number,
      title: `task-agent-${number}: queue-friendly change`,
      body: "Fixes #12\n\n## Plan\nUpdate the queue policy.\n\n## Validation\nRun merge-steward tests.",
      state: "open",
      merged: false,
      mergeable: true,
      user: {
        id: 21,
        login: "agent-one",
        username: "agent-one",
      },
      base: {
        ref: "develop",
        sha: "base-sha",
        repo: baseRepository,
      },
      head: {
        ref: "agent/change",
        sha: `head-sha-${number}`,
        repo: baseRepository,
      },
      labels: [
        { id: 1, name: "queue:ready", color: "0e8a16" },
        { id: 2, name: "agent:agent-one", color: "ff5800" },
      ],
    },
    sender: {
      id: 21,
      login: "agent-one",
      username: "agent-one",
    },
  };
}

function signedHeaders(rawBody, headers = {}) {
  return {
    ...headers,
    "x-forgejo-signature": createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex"),
  };
}

function readyItem(overrides = {}) {
  return {
    repo: "elizaos/eliza",
    pullRequestId: 401,
    sourceBranch: "agent/change",
    targetBranch: "develop",
    headSha: "head-sha-401",
    authorKind: "agent",
    ownerAgentId: "agent-one",
    agentKnown: true,
    hasIssueLink: true,
    hasExecutionPlan: true,
    hasValidationPlan: true,
    targetProtected: true,
    reviewSatisfied: true,
    headShaMatches: true,
    changedFiles: ["README.md"],
    requiredChecks: ["smoke"],
    checkResults: { smoke: "success" },
    ...overrides,
  };
}

function agentClaim(overrides = {}) {
  return {
    repo: "elizaos/eliza",
    resourceKind: "path",
    resourceId: "src/core.ts",
    ownerAgentId: "agent-one",
    taskId: "task-one",
    paths: ["src/core.ts"],
    metadata: { reason: "editing" },
    ...overrides,
  };
}

function oidcVerifierFor(tokens) {
  return {
    async verify(token) {
      const identity = tokens[token];
      if (!identity) {
        throw new Error("invalid token");
      }

      return identity;
    },
  };
}

function oidcJsonHeaders(token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
  };
}

function jsonHeaders(token) {
  return {
    ...authHeaders(token),
    "content-type": "application/json",
  };
}

async function withServer(config, fn, { authVerifier } = {}) {
  const testStore = new InMemoryQueueStore();
  const testServer = createServer({
    config,
    logger: silentLogger,
    authVerifier,
    steward: new MergeSteward({
      config,
      store: testStore,
      logger: silentLogger,
    }),
  });

  await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
  const address = testServer.address();
  const testBaseUrl = `http://${address.address}:${address.port}`;

  try {
    await fn(testBaseUrl, testStore);
  } finally {
    await new Promise((resolve, reject) => {
      testServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
