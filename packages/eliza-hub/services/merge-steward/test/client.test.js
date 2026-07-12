import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMergeStewardClient,
  createMergeStewardClientFromEnv,
  encodeStewardSegment,
  MergeStewardClient,
  MergeStewardClientError,
  resolveStewardUrl,
  summarizeAgentBootstrap,
  summarizeDiscoveryManifest,
  summarizeProductionCutover,
  summarizeProductionReadiness,
} from "../src/client.js";

describe("MergeStewardClient", () => {
  it("resolves steward paths below reverse-proxy base paths", () => {
    const url = resolveStewardUrl(
      "https://git.example.invalid/steward",
      "/api/agent-routing",
      {
        repo: "elizaos/eliza",
        readiness: false,
        lane: ["ready", "blocked"],
        empty: "",
        skipped: null,
      },
    );

    assert.equal(
      url.href,
      "https://git.example.invalid/steward/api/agent-routing?repo=elizaos%2Feliza&readiness=false&lane=ready&lane=blocked&empty=",
    );
  });

  it("rejects absolute or traversing request paths", () => {
    assert.throws(
      () =>
        resolveStewardUrl(
          "https://git.example.invalid/steward",
          "https://other.invalid/api",
        ),
      /relative to baseUrl/,
    );
    assert.throws(
      () =>
        resolveStewardUrl(
          "https://git.example.invalid/steward",
          "../api/queue",
        ),
      /cannot traverse/,
    );
  });

  it("fetches discovery and OpenAPI without bearer auth", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/steward/.well-known/eliza-hub.json": jsonResponse(200, {
        service: "eliza-merge-steward",
      }),
      "/steward/openapi.json": jsonResponse(200, { openapi: "3.1.0" }),
    });
    const client = createMergeStewardClient({
      baseUrl: "https://git.example.invalid/steward",
      token: "secret-token",
      fetchImpl,
    });

    assert.deepEqual(await client.discover(), {
      service: "eliza-merge-steward",
    });
    assert.deepEqual(await client.getOpenApi(), { openapi: "3.1.0" });

    assert.equal(calls[0].url.pathname, "/steward/.well-known/eliza-hub.json");
    assert.equal(calls[1].url.pathname, "/steward/openapi.json");
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(calls[1].init.headers.Authorization, undefined);
  });

  it("summarizes typed discovery policy hints for agent clients", async () => {
    const manifest = discoveryManifestFixture();
    const { fetchImpl, calls } = fakeFetch({
      "/steward/.well-known/eliza-hub.json": jsonResponse(200, manifest),
    });
    const client = createMergeStewardClient({
      baseUrl: "https://git.example.invalid/steward",
      token: "secret-token",
      fetchImpl,
    });

    const summary = await client.getDiscoverySummary();

    assert.equal(calls[0].url.pathname, "/steward/.well-known/eliza-hub.json");
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.deepEqual(summary.auth, {
      requiredForApiRoutes: true,
      modes: ["oidc_bearer", "static_bearer"],
      bearerHeader: "Authorization: Bearer <token>",
      oidcIssuer: "https://cloud.example.invalid",
      oidcAudience: "eliza-merge-steward",
    });
    assert.equal(
      summary.routes.agentCockpitTemplate,
      "/api/agents/{agentId}/cockpit",
    );
    assert.equal(summary.surfaces.gitAuthority, "forgejo_native");
    assert.equal(summary.surfaces.mergeQueueAuthority, "eliza_steward");
    assert.equal(
      summary.surfaces.discussionsStatus,
      "not_supported_as_native_discussions",
    );
    assert.deepEqual(summary.agentPolicy, {
      branchNamespaceRequired: true,
      branchNamespacePrefix: "agent",
      branchNamespacePattern: "agent/{agentId}/",
      runReceiptRequired: true,
      runReceiptVerified: true,
      runReceiptSignatureAlgorithm: "hmac-sha256",
      workItemRequiredForAgentPrs: true,
      workItemLinkRequiredBeforeMerge: true,
      workItemMatchKeys: ["pullRequestId", "taskId", "issueId"],
      workItemActiveStates: ["backlog", "ready", "in_progress", "blocked"],
      workItemTerminalStates: ["done", "cancelled"],
      identityRegistryRequired: true,
      knownAgentIdCount: 4,
      configuredAgentIdCount: 3,
      persistedActiveAgentIdCount: 2,
      identityField: "ownerAgentId",
    });
    assert.equal(summary.mergeExecution.liveExecutionConfigured, true);
    assert.equal(summary.mergeExecution.productionCutoverRequired, true);
    assert.equal(
      summary.mergeExecution.liveAgentMergesRequireProductionEvidence,
      true,
    );
    assert.equal(
      summary.mergeExecution.liveAgentMergesAllowedWithoutProductionEvidence,
      false,
    );
    assert.equal(summary.productionReadiness.productionReady, false);
    assert.equal(
      summary.productionEvidence.artifactRootEnv,
      "ELIZA_ARTIFACT_ROOT",
    );
    assert.equal(
      summary.productionEvidence.templateFile,
      "eliza-hub-production-evidence.template.json",
    );
    assert.equal(
      summary.productionEvidence.assembledEvidenceFile,
      "eliza-hub-production-evidence.json",
    );
    assert.match(
      summary.productionEvidence.templateCommand,
      /production-evidence-template/,
    );
    assert.match(
      summary.productionEvidence.inventoryCommand,
      /production-evidence-inventory\.mjs --strict/,
    );
    assert.match(
      summary.productionEvidence.assembleCommand,
      /production-evidence-assemble\.mjs/,
    );
    assert.match(
      summary.productionEvidence.gateCommand,
      /production-gate --strict/,
    );
    assert.equal(summary.productionEvidence.strictGateRequired, true);
    assert.equal(
      summary.productionEvidence.inventoryMustPassBeforeAssemble,
      true,
    );
    assert.equal(
      summary.productionEvidence.generatedEvidenceMustStayPrivate,
      true,
    );
    assert.equal(summary.githubParity.githubDropInReplacement, false);
  });

  it("summarizes partial discovery manifests without granting live merge authority", () => {
    const summary = summarizeDiscoveryManifest({
      service: "eliza-merge-steward",
      clientHints: {
        mergeExecution: {
          liveIntegrationActive: true,
          workerEnabled: true,
          workerLiveExecutionConfirmed: true,
        },
      },
    });

    assert.equal(summary.service, "eliza-merge-steward");
    assert.equal(summary.auth.requiredForApiRoutes, false);
    assert.deepEqual(summary.agentPolicy.workItemMatchKeys, []);
    assert.equal(summary.mergeExecution.liveExecutionConfigured, false);
    assert.equal(
      summary.mergeExecution.liveAgentMergesRequireProductionEvidence,
      false,
    );
    assert.equal(summary.productionReadiness.productionReady, false);
    assert.equal(summary.productionEvidence.strictGateRequired, false);
    assert.equal(summary.productionEvidence.inventoryCommand, null);
    assert.equal(summary.githubParity.githubDropInReplacement, false);
  });

  it("summarizes production readiness helper steps for agent clients", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/steward/api/production-readiness?repo=elizaos%2Feliza": jsonResponse(
        200,
        productionReadinessFixture(),
      ),
    });
    const client = createMergeStewardClient({
      baseUrl: "https://git.example.invalid/steward",
      token: "secret-token",
      fetchImpl,
    });

    const summary = await client.getProductionReadinessSummary({
      repo: "elizaos/eliza",
    });
    const directSummary = summarizeProductionReadiness(
      productionReadinessFixture(),
    );

    assert.equal(calls[0].url.pathname, "/steward/api/production-readiness");
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
    assert.equal(summary.productionReady, false);
    assert.equal(summary.gatePassed, false);
    assert.deepEqual(summary.blockedDomains, [
      "sso_registration",
      "runner_isolation",
    ]);
    assert.equal(summary.nextAction.id, "sso_registration");
    assert.match(summary.primaryHelperCommand, /sso-evidence\.mjs/);
    assert.match(summary.nextHelperCommand, /bootstrap-forgejo-identity\.sh/);
    assert.match(
      summary.nextHelperStep.command,
      /bootstrap-forgejo-identity\.sh/,
    );
    assert.deepEqual(
      summary.nextAction.helperSteps.map((step) => step.id),
      [
        "verify_forgejo_identity_bootstrap",
        "capture_sso_smoke_artifact",
        "generate_sso_production_evidence",
      ],
    );
    assert.deepEqual(
      summary.domainStatuses.map((domain) => [
        domain.id,
        domain.helperStepCount,
      ]),
      [
        ["sso_registration", 3],
        ["runner_isolation", 1],
      ],
    );
    assert.deepEqual(
      directSummary.nextAction.helperSteps,
      summary.nextAction.helperSteps,
    );
  });

  it("summarizes production cutover guardrails and first helper step", async () => {
    const { fetchImpl } = fakeFetch({
      "/steward/api/production-cutover": jsonResponse(
        200,
        productionCutoverFixture(),
      ),
    });
    const client = createMergeStewardClient({
      baseUrl: "https://git.example.invalid/steward",
      token: "secret-token",
      fetchImpl,
    });

    const summary = await client.getProductionCutoverSummary();
    const partial = summarizeProductionCutover({});

    assert.equal(summary.status, "blocked");
    assert.equal(summary.productionReady, false);
    assert.equal(summary.liveAgentMergesAllowed, false);
    assert.equal(summary.githubMigrationReady, false);
    assert.equal(summary.githubMigration.status, "blocked");
    assert.equal(summary.githubMigration.link, "/api/github-parity");
    assert.deepEqual(summary.githubMigration.blockedSurfaces, ["merge_queue"]);
    assert.deepEqual(summary.githubMigration.acceptedGapSurfaces, [
      "discussions",
      "codespaces",
    ]);
    assert.equal(summary.mutatesState, false);
    assert.equal(summary.storesPrivateEvidence, false);
    assert.equal(summary.nextPhase.id, "identity_and_access");
    assert.equal(summary.nextPhase.firstAction.id, "sso_registration");
    assert.equal(summary.orderedStepCount, 1);
    assert.equal(summary.firstStep.domainId, "sso_registration");
    assert.match(summary.primaryHelperCommand, /sso-evidence\.mjs/);
    assert.match(summary.firstHelperCommand, /bootstrap-forgejo-identity\.sh/);
    assert.match(
      summary.firstHelperStep.command,
      /bootstrap-forgejo-identity\.sh/,
    );
    assert.match(
      summary.assemblyCommands[0],
      /production-evidence-inventory\.mjs --strict/,
    );
    assert.ok(
      summary.finalVerificationCommands.some((command) =>
        /release-gate\.sh/.test(command),
      ),
    );
    assert.equal(partial.productionReady, false);
    assert.equal(partial.liveAgentMergesAllowed, false);
    assert.equal(partial.firstStep, null);
  });

  it("bootstraps from standard environment variables", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/steward/api/agent-routing?repo=elizaos%2Feliza": jsonResponse(200, {
        routing: { recommendations: [] },
      }),
    });
    const client = createMergeStewardClientFromEnv(
      {
        MERGE_STEWARD_URL: "https://git.example.invalid/steward",
        MERGE_STEWARD_API_TOKEN: "secret-token",
      },
      { fetchImpl },
    );

    assert.deepEqual(await client.getAgentRouting({ repo: "elizaos/eliza" }), {
      routing: { recommendations: [] },
    });
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");

    assert.throws(
      () => createMergeStewardClientFromEnv({}, { fetchImpl }),
      /MERGE_STEWARD_URL/,
    );
  });

  it("encodes agent path segments and sends bearer auth to control APIs", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/steward/api/agents/agent%2Fone/inbox?repo=elizaos%2Feliza&readiness=false":
        jsonResponse(200, {
          inbox: { cards: [] },
        }),
    });
    const client = new MergeStewardClient({
      baseUrl: "https://git.example.invalid/steward/",
      token: "secret-token",
      fetchImpl,
    });

    assert.deepEqual(
      await client.getAgentInbox("agent/one", {
        repo: "elizaos/eliza",
        readiness: false,
      }),
      {
        inbox: { cards: [] },
      },
    );

    assert.equal(
      calls[0].url.pathname,
      "/steward/api/agents/agent%2Fone/inbox",
    );
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
  });

  it("fetches the one-call agent cockpit helper", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/steward/api/agents/agent%2Fone/cockpit?repo=elizaos%2Feliza&targetBranch=develop&readiness=false":
        jsonResponse(200, {
          cockpit: { agentId: "agent/one" },
        }),
    });
    const client = new MergeStewardClient({
      baseUrl: "https://git.example.invalid/steward/",
      token: "secret-token",
      fetchImpl,
    });

    assert.deepEqual(
      await client.getAgentCockpit("agent/one", {
        repo: "elizaos/eliza",
        targetBranch: "develop",
        readiness: false,
      }),
      {
        cockpit: { agentId: "agent/one" },
      },
    );

    assert.equal(
      calls[0].url.pathname,
      "/steward/api/agents/agent%2Fone/cockpit",
    );
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
  });

  it("summarizes agent bootstrap into startup decisions for runtimes", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/steward/api/agents/agent%2Fone/bootstrap?repo=elizaos%2Feliza&readiness=false":
        jsonResponse(200, {
          bootstrap: agentBootstrapFixture(),
        }),
    });
    const client = new MergeStewardClient({
      baseUrl: "https://git.example.invalid/steward/",
      token: "secret-token",
      fetchImpl,
    });

    const summary = await client.getAgentBootstrapSummary("agent/one", {
      repo: "elizaos/eliza",
      readiness: false,
    });

    assert.equal(
      calls[0].url.pathname,
      "/steward/api/agents/agent%2Fone/bootstrap",
    );
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
    assert.equal(summary.agentId, "agent/one");
    assert.equal(summary.filters.repo, "elizaos/eliza");
    assert.equal(summary.identity.state, "unregistered_blocked");
    assert.equal(summary.identity.accepted, false);
    assert.equal(summary.identity.registryKnownAgentIdCount, 2);
    assert.equal(summary.policy.workReservationRequired, true);
    assert.equal(summary.policy.workItemRequired, true);
    assert.deepEqual(summary.policy.workItemMatchKeys, [
      "pullRequestId",
      "taskId",
      "issueId",
    ]);
    assert.equal(summary.policy.branchNamespaceRequired, true);
    assert.equal(summary.policy.expectedBranchPrefix, "agent/agent/one/");
    assert.equal(summary.policy.runReceiptVerified, true);
    assert.equal(summary.submissionGate.recentSubmissionWindowMinutes, 60);
    assert.equal(summary.work.inboxCardCount, 3);
    assert.equal(summary.work.staleClaimCount, 2);
    assert.equal(summary.workflow.controlPlaneBlocked, true);
    assert.equal(summary.workflow.runnerStatus, "private_evidence_required");
    assert.equal(summary.mergeQueue.integrationEnabled, true);
    assert.equal(summary.mergeQueue.integrationDryRun, false);
    assert.equal(summary.mergeQueue.dryRunReviewReady, true);
    assert.deepEqual(summary.nextActions.blockingIds, [
      "register_agent_identity",
    ]);
    assert.equal(
      summary.nextActions.firstBlocking.href,
      "/api/agent-identities",
    );
    assert.equal(summary.startup.blocked, true);
    assert.ok(summary.startup.blockingReasons.includes("agent_identity"));
    assert.ok(summary.startup.blockingReasons.includes("control_plane"));
    assert.ok(summary.startup.blockingReasons.includes("stale_claims"));
    assert.equal(summary.startup.shouldPreflightBeforeBranch, true);
    assert.equal(summary.startup.shouldPreviewClaim, true);
    assert.equal(
      summary.links.workPreflight,
      "/api/agents/agent%2Fone/work-preflight",
    );
  });

  it("summarizes partial agent bootstrap payloads conservatively", () => {
    const summary = summarizeAgentBootstrap({
      agentId: "agent-one",
      policyHints: {
        mergeQueue: {
          liveExecutionReady: true,
        },
      },
    });

    assert.equal(summary.agentId, "agent-one");
    assert.equal(summary.identity.accepted, false);
    assert.equal(summary.policy.workReservationRequired, false);
    assert.deepEqual(summary.policy.workItemMatchKeys, []);
    assert.equal(summary.work.inboxCardCount, 0);
    assert.equal(summary.nextActions.count, 0);
    assert.equal(summary.startup.blocked, false);
    assert.equal(summary.startup.shouldPreflightBeforeBranch, false);
    assert.equal(summary.links.workPreflight, null);
  });

  it("fetches the PR-scoped queue item action plan helper", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/steward/api/queue/item/action-plan?id=elizaos%2Feliza%2342&ownerAgentId=agent-one&readiness=false":
        jsonResponse(200, {
          queueItemActionPlan: { item: { id: "elizaos/eliza#42" } },
        }),
    });
    const client = new MergeStewardClient({
      baseUrl: "https://git.example.invalid/steward/",
      token: "secret-token",
      fetchImpl,
    });

    assert.deepEqual(
      await client.getQueueItemActionPlan("elizaos/eliza#42", {
        ownerAgentId: "agent-one",
        readiness: false,
      }),
      {
        queueItemActionPlan: { item: { id: "elizaos/eliza#42" } },
      },
    );

    assert.equal(calls[0].url.pathname, "/steward/api/queue/item/action-plan");
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
  });

  it("provides OpenAPI operationId aliases for generated-client parity", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const client = new MergeStewardClient({
      baseUrl: "https://git.example.invalid/steward",
      token: "secret-token",
      fetchImpl,
    });

    await client.planCiValidation({
      changedFiles: ["packages/core/src/runtime.ts"],
    });
    await client.claimSuggestedAssignment("agent/one", {
      repo: "elizaos/eliza",
    });
    await client.claimNextAgentWork("agent/one", { repo: "elizaos/eliza" });
    await client.evaluateQueueItem({ id: "elizaos/eliza#1" });
    await client.scheduleQueueItems({ items: [] });
    await client.planIntegrationItems({ items: [] });
    await client.runQueueOnce({ confirm: false });

    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url.pathname}`),
      [
        "POST /steward/api/ci/validation-plan",
        "POST /steward/api/agents/agent%2Fone/claim-assignment",
        "POST /steward/api/agents/agent%2Fone/claim-next",
        "POST /steward/api/queue/evaluate",
        "POST /steward/api/queue/schedule",
        "POST /steward/api/queue/integration-plan",
        "POST /steward/api/queue/run-once",
      ],
    );
  });

  it("posts JSON bodies without mistaking payload keys for request options", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/api/agents/agent-one/claim-next": jsonResponse(200, {
        claim: { id: "claim:one" },
      }),
    });
    const client = new MergeStewardClient({
      baseUrl: "https://git.example.invalid",
      token: "secret-token",
      fetchImpl,
      defaultHeaders: { "X-Eliza-Agent": "agent-one" },
    });

    const result = await client.claimNext("agent-one", {
      repo: "elizaos/eliza",
      dryRun: true,
      query: "this is part of the body",
    });

    assert.deepEqual(result, { claim: { id: "claim:one" } });
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.equal(calls[0].init.headers["X-Eliza-Agent"], "agent-one");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      repo: "elizaos/eliza",
      dryRun: true,
      query: "this is part of the body",
    });
  });

  it("provides named helpers for runtime and coordination APIs", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const client = new MergeStewardClient({
      baseUrl: "https://git.example.invalid/steward",
      token: "secret-token",
      fetchImpl,
    });

    await client.getMetrics();
    await client.getGithubParity();
    await client.getProductionReadiness();
    await client.getProductionCutover();
    await client.getProductionEvidenceTemplate();
    await client.getCoordination({ repo: "elizaos/eliza" });
    await client.getFleetCoordination({
      repo: "elizaos/eliza",
      ownerAgentId: "agent/one",
    });
    await client.getWorkContext({
      repo: "elizaos/eliza",
      ownerAgentId: "agent/one",
      targetBranch: "develop",
    });
    await client.search({
      q: "failed typecheck",
      repo: "elizaos/eliza",
      kind: ["pull_request", "actions_log"],
    });
    await client.searchContext({ query: "failed typecheck", documents: [] });
    await client.listWorkItems({ repo: "elizaos/eliza", state: "ready" });
    await client.getWorkItem("work:elizaos/eliza:task:docs");
    await client.upsertWorkItem({
      repo: "elizaos/eliza",
      taskId: "docs",
      title: "Docs work",
    });
    await client.transitionWorkItem({
      id: "work:elizaos/eliza:task:docs",
      state: "in_progress",
    });
    await client.listWorkCycles({ repo: "elizaos/eliza", state: "active" });
    await client.getWorkCycle("cycle:elizaos/eliza:july");
    await client.upsertWorkCycle({
      repo: "elizaos/eliza",
      title: "July cycle",
    });
    await client.transitionWorkCycle({
      id: "cycle:elizaos/eliza:july",
      state: "completed",
    });
    await client.listWorkModules({ repo: "elizaos/eliza", state: "active" });
    await client.getWorkModule("module:elizaos/eliza:runtime");
    await client.upsertWorkModule({ repo: "elizaos/eliza", title: "Runtime" });
    await client.transitionWorkModule({
      id: "module:elizaos/eliza:runtime",
      state: "archived",
    });
    await client.getWorkProgress({ repo: "elizaos/eliza" });
    await client.listWorkViews({ repo: "elizaos/eliza", kind: "dashboard" });
    await client.getWorkView("view:elizaos/eliza:blocked-docs");
    await client.upsertWorkView({
      repo: "elizaos/eliza",
      title: "Blocked docs",
      kind: "dashboard",
    });
    await client.evaluateWorkView({
      id: "view:elizaos/eliza:blocked-docs",
      repo: "elizaos/eliza",
    });
    await client.previewWorkView({
      repo: "elizaos/eliza",
      view: { title: "Blocked docs", filters: { state: ["blocked"] } },
    });
    await client.transitionWorkView({
      id: "view:elizaos/eliza:blocked-docs",
      state: "archived",
    });
    await client.listWorkPages({ repo: "elizaos/eliza", kind: "agent_plan" });
    await client.getWorkPage(
      "page:elizaos/eliza:work:work-elizaos-eliza-task-docs:agent_plan",
    );
    await client.upsertWorkPage({
      repo: "elizaos/eliza",
      title: "Docs plan",
      kind: "agent_plan",
    });
    await client.transitionWorkPage({
      id: "page:elizaos/eliza:work:work-elizaos-eliza-task-docs:agent_plan",
      state: "archived",
    });
    await client.getWorkDashboard({ repo: "elizaos/eliza" });
    await client.getWorkIntake({ repo: "elizaos/eliza" });
    await client.applyWorkIntake({ confirm: true, repo: "elizaos/eliza" });
    await client.getMergeTrain({
      repo: "elizaos/eliza",
      targetBranch: "develop",
    });
    await client.getQueueItemActionPlan("elizaos/eliza#42", {
      ownerAgentId: "agent/one",
      readiness: false,
    });
    await client.simulateQueue({
      repo: "elizaos/eliza",
      proposedItem: { pullRequestId: 12 },
    });
    await client.getAgentBootstrap("agent/one", {
      repo: "elizaos/eliza",
      readiness: false,
    });
    await client.getAgentCockpit("agent/one", {
      repo: "elizaos/eliza",
      targetBranch: "develop",
      readiness: false,
    });
    await client.getReleaseReadiness({
      repo: "elizaos/eliza",
      readiness: false,
    });
    await client.getRepositoryProtection({
      repo: "elizaos/eliza",
      requireLive: false,
    });
    await client.analyzeCiFailures({
      queueItemId: "elizaos/eliza#1",
      checks: [],
    });
    await client.planValidation({
      changedFiles: ["packages/core/src/runtime.ts"],
    });
    await client.getPullRequestBrief({ queueItemId: "elizaos/eliza#1" });
    await client.assignReviewers({
      repo: "elizaos/eliza",
      changedFiles: ["packages/core/src/runtime.ts"],
    });
    await client.predictPatchConflicts({
      repo: "elizaos/eliza",
      changedFiles: ["packages/core/src/runtime.ts"],
    });
    await client.getReleaseNotes({ repo: "elizaos/eliza", version: "2.1.0" });
    await client.buildReleaseNotes({ repo: "elizaos/eliza", items: [] });
    await client.getAgentActionPlan("agent/one", {
      repo: "elizaos/eliza",
      query: "failed typecheck",
    });
    await client.getAgentSubmissionGate("agent/one", { repo: "elizaos/eliza" });
    await client.getAgentWorkPreflight("agent/one", { repo: "elizaos/eliza" });
    await client.reserveAgentWork("agent/one", {
      repo: "elizaos/eliza",
      dryRun: true,
    });
    await client.listApprovals({ status: "pending" });
    await client.createApproval({ id: "approval-one" });
    await client.decideApproval({ id: "approval-one", decision: "approved" });
    await client.listHumanRequests({ status: "waiting" });
    await client.getHumanRequest("human:run-one:review:0");
    await client.createHumanRequest({ id: "human-one" });
    await client.respondToHumanRequest({ id: "human-one", response: "done" });
    await client.listSignals({ runId: "run-one" });
    await client.createSignal({ id: "signal-one" });
    await client.consumeSignal({ id: "signal-one" });
    await client.listAgentIdentities({ status: "active" });
    await client.getAgentIdentity("agent/one");
    await client.upsertAgentIdentity({ agentId: "agent-one" });
    await client.disableAgentIdentity({ id: "agent-one" });
    await client.listRuns({ repo: "elizaos/eliza" });
    await client.createRun({ id: "run-one" });
    await client.getRun("run/one");
    await client.getRunState("run/one");
    await client.listRunNodes("run/one");
    await client.createRunNode("run/one", { id: "node-one" });
    await client.listRunAttempts("run/one");
    await client.createRunAttempt("run/one", { id: "attempt-one" });
    await client.listRunEvents("run/one", { afterSeq: 1 });
    await client.createRunEvent("run/one", { type: "claim" });
    await client.getAttempt("attempt:run-one:checks:1");
    await client.heartbeatAttempt({ id: "attempt-one" });
    await client.finishAttempt({ id: "attempt-one" });
    await client.failAttempt({ id: "attempt-one" });
    await client.cancelAttempt({ id: "attempt-one" });
    await client.claimStaleAttempts({ limit: 5 });
    await client.sendForgejoWebhook(JSON.stringify({ action: "opened" }), {
      headers: {
        "Content-Type": "application/json",
        "X-Forgejo-Signature": "sha256=signature",
      },
    });

    assert.deepEqual(
      calls.map(
        (call) => `${call.init.method} ${call.url.pathname}${call.url.search}`,
      ),
      [
        "GET /steward/metrics",
        "GET /steward/api/github-parity",
        "GET /steward/api/production-readiness",
        "GET /steward/api/production-cutover",
        "GET /steward/api/production-evidence-template",
        "GET /steward/api/coordination?repo=elizaos%2Feliza",
        "GET /steward/api/fleet-coordination?repo=elizaos%2Feliza&ownerAgentId=agent%2Fone",
        "GET /steward/api/work-context?repo=elizaos%2Feliza&ownerAgentId=agent%2Fone&targetBranch=develop",
        "GET /steward/api/search?q=failed+typecheck&repo=elizaos%2Feliza&kind=pull_request&kind=actions_log",
        "POST /steward/api/search",
        "GET /steward/api/work-items?repo=elizaos%2Feliza&state=ready",
        "GET /steward/api/work-items/item?id=work%3Aelizaos%2Feliza%3Atask%3Adocs",
        "POST /steward/api/work-items",
        "POST /steward/api/work-items/transition",
        "GET /steward/api/work-cycles?repo=elizaos%2Feliza&state=active",
        "GET /steward/api/work-cycles/item?id=cycle%3Aelizaos%2Feliza%3Ajuly",
        "POST /steward/api/work-cycles",
        "POST /steward/api/work-cycles/transition",
        "GET /steward/api/work-modules?repo=elizaos%2Feliza&state=active",
        "GET /steward/api/work-modules/item?id=module%3Aelizaos%2Feliza%3Aruntime",
        "POST /steward/api/work-modules",
        "POST /steward/api/work-modules/transition",
        "GET /steward/api/work-progress?repo=elizaos%2Feliza",
        "GET /steward/api/work-views?repo=elizaos%2Feliza&kind=dashboard",
        "GET /steward/api/work-views/item?id=view%3Aelizaos%2Feliza%3Ablocked-docs",
        "POST /steward/api/work-views",
        "GET /steward/api/work-views/evaluate?id=view%3Aelizaos%2Feliza%3Ablocked-docs&repo=elizaos%2Feliza",
        "POST /steward/api/work-views/evaluate",
        "POST /steward/api/work-views/transition",
        "GET /steward/api/work-pages?repo=elizaos%2Feliza&kind=agent_plan",
        "GET /steward/api/work-pages/item?id=page%3Aelizaos%2Feliza%3Awork%3Awork-elizaos-eliza-task-docs%3Aagent_plan",
        "POST /steward/api/work-pages",
        "POST /steward/api/work-pages/transition",
        "GET /steward/api/work-dashboard?repo=elizaos%2Feliza",
        "GET /steward/api/work-intake?repo=elizaos%2Feliza",
        "POST /steward/api/work-intake/apply",
        "GET /steward/api/merge-train?repo=elizaos%2Feliza&targetBranch=develop",
        "GET /steward/api/queue/item/action-plan?id=elizaos%2Feliza%2342&ownerAgentId=agent%2Fone&readiness=false",
        "POST /steward/api/queue/simulate",
        "GET /steward/api/agents/agent%2Fone/bootstrap?repo=elizaos%2Feliza&readiness=false",
        "GET /steward/api/agents/agent%2Fone/cockpit?repo=elizaos%2Feliza&targetBranch=develop&readiness=false",
        "GET /steward/api/release-readiness?repo=elizaos%2Feliza&readiness=false",
        "GET /steward/api/repository-protection?repo=elizaos%2Feliza&requireLive=false",
        "POST /steward/api/ci/failure-analysis",
        "POST /steward/api/ci/validation-plan",
        "POST /steward/api/pr/brief",
        "POST /steward/api/review/assignment",
        "POST /steward/api/patch/conflict-prediction",
        "GET /steward/api/releases/notes?repo=elizaos%2Feliza&version=2.1.0",
        "POST /steward/api/releases/notes",
        "POST /steward/api/agents/agent%2Fone/action-plan",
        "POST /steward/api/agents/agent%2Fone/submission-gate",
        "POST /steward/api/agents/agent%2Fone/work-preflight",
        "POST /steward/api/agents/agent%2Fone/work-reservation",
        "GET /steward/api/approvals?status=pending",
        "POST /steward/api/approvals",
        "POST /steward/api/approvals/decide",
        "GET /steward/api/human-requests?status=waiting",
        "GET /steward/api/human-requests/item?id=human%3Arun-one%3Areview%3A0",
        "POST /steward/api/human-requests",
        "POST /steward/api/human-requests/respond",
        "GET /steward/api/signals?runId=run-one",
        "POST /steward/api/signals",
        "POST /steward/api/signals/consume",
        "GET /steward/api/agent-identities?status=active",
        "GET /steward/api/agent-identities/item?id=agent%2Fone",
        "POST /steward/api/agent-identities",
        "POST /steward/api/agent-identities/disable",
        "GET /steward/api/runs?repo=elizaos%2Feliza",
        "POST /steward/api/runs",
        "GET /steward/api/runs/run%2Fone",
        "GET /steward/api/runs/run%2Fone/run-state",
        "GET /steward/api/runs/run%2Fone/nodes",
        "POST /steward/api/runs/run%2Fone/nodes",
        "GET /steward/api/runs/run%2Fone/attempts",
        "POST /steward/api/runs/run%2Fone/attempts",
        "GET /steward/api/runs/run%2Fone/events?afterSeq=1",
        "POST /steward/api/runs/run%2Fone/events",
        "GET /steward/api/attempts/item?id=attempt%3Arun-one%3Achecks%3A1",
        "POST /steward/api/attempts/heartbeat",
        "POST /steward/api/attempts/finish",
        "POST /steward/api/attempts/fail",
        "POST /steward/api/attempts/cancel",
        "POST /steward/api/attempts/claim-stale",
        "POST /steward/api/webhooks/forgejo",
      ],
    );
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
    assert.equal(calls.at(-1).init.headers.Authorization, undefined);
    assert.equal(
      calls.at(-1).init.headers["X-Forgejo-Signature"],
      "sha256=signature",
    );
  });

  it("keeps structured error details for failed requests", async () => {
    const { fetchImpl } = fakeFetch({
      "/steward/api/agent-routing": jsonResponse(
        409,
        { error: "blocked" },
        "Conflict",
      ),
    });
    const client = new MergeStewardClient({
      baseUrl: "https://git.example.invalid/steward",
      fetchImpl,
    });

    await assert.rejects(
      () => client.getAgentRouting(),
      (error) => {
        assert.equal(error instanceof MergeStewardClientError, true);
        assert.equal(error.status, 409);
        assert.equal(error.statusText, "Conflict");
        assert.deepEqual(error.body, { error: "blocked" });
        assert.equal(error.method, "GET");
        assert.equal(
          error.url,
          "https://git.example.invalid/steward/api/agent-routing",
        );
        return true;
      },
    );
  });

  it("validates required path segments", () => {
    assert.equal(encodeStewardSegment("agent/one"), "agent%2Fone");
    assert.throws(() => encodeStewardSegment(""), /must be present/);
  });
});

function fakeFetch(routes) {
  const calls = [];

  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      const key = `${url.pathname}${url.search}`;
      const response = routes[key] ?? routes[url.pathname];
      if (!response) {
        throw new Error(`missing fake route ${key}`);
      }
      return response;
    },
  };
}

function recordingFetch(response = jsonResponse(200, { ok: true })) {
  const calls = [];

  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return response;
    },
  };
}

function jsonResponse(status, body, statusText = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type"
          ? "application/json"
          : null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function productionReadinessFixture() {
  return {
    productionReadiness: {
      schema: "https://eliza.hub/schemas/production-readiness.v1",
      checklistVersion: 1,
      generatedAt: "2026-07-07T00:00:00.000Z",
      status: "blocked_until_private_evidence_passes",
      currentUse: "demo_ready",
      productionReady: false,
      privateEvidenceRequired: true,
      privateEvidenceEvaluated: true,
      authoritativeGate: {
        command:
          'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
      },
      summary: {
        totalDomains: 2,
        passedDomains: [],
        blockedDomains: ["sso_registration", "runner_isolation"],
        gatePassed: false,
        failedExtraChecks: ["production_evidence_artifacts"],
        evidenceBlocks: ["sso", "runner"],
      },
      domains: [
        {
          id: "sso_registration",
          title: "Eliza Cloud SSO and registration lock",
          status: "blocked",
          evidenceBlock: "sso",
          helper: "node deployment/hetzner-staging/scripts/sso-evidence.mjs",
          helperSteps: ssoHelperStepsFixture(),
          gateCheck: {
            ok: false,
            errors: [
              {
                code: "missing_required_true",
                message: "sso.smokeEvidence is required",
              },
            ],
          },
        },
        {
          id: "runner_isolation",
          title: "Isolated trusted runner pool",
          status: "blocked",
          evidenceBlock: "runner",
          helper: "deployment/hetzner-staging/scripts/runner-evidence.sh",
          helperSteps: [
            {
              id: "runner_isolation_evidence",
              command: "deployment/hetzner-staging/scripts/runner-evidence.sh",
              description: "Register and smoke-test the isolated runner.",
              requires: [],
            },
          ],
          gateCheck: {
            ok: false,
            errors: [],
          },
        },
      ],
      nextActions: [
        {
          id: "sso_registration",
          status: "blocked",
          evidenceBlock: "sso",
          helper: "node deployment/hetzner-staging/scripts/sso-evidence.mjs",
          helperSteps: ssoHelperStepsFixture(),
          nextAction: "Complete live Eliza Cloud identity smoke tests.",
          missingEvidence: ["sso.smokeEvidence is required"],
        },
        {
          id: "runner_isolation",
          status: "blocked",
          evidenceBlock: "runner",
          helper: "deployment/hetzner-staging/scripts/runner-evidence.sh",
          helperSteps: [],
          nextAction: "Register isolated trusted runners.",
          missingEvidence: ["runner.smokeEvidence is required"],
        },
      ],
    },
  };
}

function productionCutoverFixture() {
  return {
    productionCutover: {
      schema: "https://eliza.hub/schemas/production-cutover-plan.v1",
      planVersion: 1,
      generatedAt: "2026-07-07T00:00:00.000Z",
      readOnly: true,
      status: "blocked",
      productionReady: false,
      privateEvidenceRequired: true,
      privateEvidenceEvaluated: true,
      nextPhase: {
        id: "identity_and_access",
        title: "Identity, secrets, and access",
        blockers: ["sso_registration"],
        firstAction: {
          id: "sso_registration",
          helper: "node deployment/hetzner-staging/scripts/sso-evidence.mjs",
          helperSteps: ssoHelperStepsFixture(),
        },
      },
      summary: {
        blockedPhases: 1,
        blockedDomains: ["sso_registration"],
        passedDomains: [],
        gatePassed: false,
        githubMigrationCutoverReady: false,
        githubMigrationBlockedSurfaces: ["merge_queue"],
      },
      guardrails: {
        mutatesState: false,
        storesPrivateEvidence: false,
        liveAgentMergesAllowed: false,
        githubMigrationReady: false,
        finalGate:
          'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
      },
      githubMigration: {
        status: "blocked",
        link: "/api/github-parity",
        matrixVersion: 1,
        githubDropInReplacement: false,
        migrationMode: "surface_by_surface_with_agent_native_replacements",
        privateEvidenceEvaluated: true,
        productionGatePassed: false,
        cutoverReady: false,
        readySurfaceCount: 2,
        blockedSurfaceCount: 1,
        readySurfaces: ["discussions", "codespaces"],
        blockedSurfaces: ["merge_queue"],
        cutoverBlockerSurfaces: ["merge_queue"],
        acceptedGapSurfaces: ["discussions", "codespaces"],
      },
      executionPlan: {
        orderedSteps: [
          {
            phaseId: "identity_and_access",
            domainId: "sso_registration",
            title: "Eliza Cloud SSO and registration lock",
            evidenceBlock: "sso",
            helper: "node deployment/hetzner-staging/scripts/sso-evidence.mjs",
            helperSteps: ssoHelperStepsFixture(),
            missingEvidence: ["sso.smokeEvidence is required"],
            verification:
              "Attach the generated private evidence fragment, assemble evidence, then rerun the strict production gate.",
          },
        ],
        assemblyCommands: [
          "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
          "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
        ],
        finalVerificationCommands: [
          'RELEASE_GATE_MODE=production PRODUCTION_EVIDENCE_FILE="$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json" deployment/hetzner-staging/scripts/release-gate.sh',
        ],
      },
      labels: [
        "production-cutover:blocked",
        "github-migration:blocked",
        "identity_and_access:blocked",
      ],
    },
  };
}

function ssoHelperStepsFixture() {
  return [
    {
      id: "verify_forgejo_identity_bootstrap",
      command:
        "APPLY_BOOTSTRAP=false deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh",
      requires: [],
      produces:
        "$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json",
      description:
        "Verify live Forgejo identity bootstrap without mutating state.",
    },
    {
      id: "capture_sso_smoke_artifact",
      command: "node deployment/hetzner-staging/scripts/sso-smoke-evidence.mjs",
      requires: [],
      produces: "$ELIZA_ARTIFACT_ROOT/sso-smoke.json",
      description: "Record timestamped live identity smoke evidence.",
    },
    {
      id: "generate_sso_production_evidence",
      command:
        "node deployment/hetzner-staging/scripts/sso-evidence.mjs --smoke-json $ELIZA_ARTIFACT_ROOT/sso-smoke.json --identity-bootstrap-json $ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json",
      requires: [
        "$ELIZA_ARTIFACT_ROOT/sso-smoke.json",
        "$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json",
      ],
      produces: "$ELIZA_ARTIFACT_ROOT/eliza-hub-sso-evidence.json",
      description:
        "Convert OIDC config and smoke evidence into production evidence.",
    },
  ];
}

function agentBootstrapFixture() {
  return {
    agentId: "agent/one",
    computedAt: "2026-07-07T00:00:00.000Z",
    filters: {
      repo: "elizaos/eliza",
      targetBranch: "develop",
      ownerAgentId: "agent/one",
    },
    identity: {
      required: true,
      known: false,
      configured: false,
      persistedActive: false,
      disabled: false,
      status: null,
      state: "unregistered_blocked",
      registrySummary: {
        knownAgentIdCount: 2,
      },
    },
    policyHints: {
      workReservation: {
        required: true,
        reserveBeforePullRequest: true,
      },
      workItem: {
        required: true,
        linkBeforePullRequest: true,
        matchKeys: ["pullRequestId", "taskId", "issueId"],
      },
      agentBranchNamespace: {
        required: true,
        prefix: "agent",
        expectedPrefix: "agent/agent/one/",
      },
      agentRunReceipt: {
        required: true,
        verified: true,
        signatureAlgorithm: "hmac-sha256",
      },
      agentIdentityRegistry: {
        required: true,
        accepted: false,
        state: "unregistered_blocked",
        knownAgentIdCount: 2,
      },
      validationBudget: {
        planBeforeRunning: true,
        broadValidationBlockedByDefault: true,
      },
      submissionGate: {
        checkBeforePullRequest: true,
        maxQueuedWork: 6,
        warnQueuedWork: 4,
        maxRecentSubmissions: 8,
        warnRecentSubmissions: 5,
        recentSubmissionWindowMinutes: 60,
      },
      mergeQueue: {
        integrationEnabled: true,
        integrationDryRun: false,
        workerEnabled: true,
        trainStatus: "blocked",
        trainPreflightStatus: "blocked",
        liveExecutionReady: false,
        dryRunReviewReady: true,
      },
      workflowOperations: {
        status: "control_plane_blocked",
        actionsStatus: "ready",
        runnerStatus: "private_evidence_required",
        mergeQueueStatus: "blocked",
        nextActions: ["run_deployment_doctor"],
      },
    },
    snapshots: {
      inbox: {
        counts: {
          cards: 3,
        },
        nextActions: [{ id: "inspect_queue" }],
      },
      routing: {
        blocked: {
          agentId: "agent/one",
          reason: "identity",
        },
        recommendations: [{ id: "assignment-one", agentId: "agent/one" }],
      },
      claims: {
        counts: {
          active: 1,
          stale: 2,
          total: 3,
        },
      },
      mergeTrain: {
        status: "blocked",
        preflight: {
          status: "blocked",
        },
      },
      workflowOperations: {
        status: "control_plane_blocked",
        actions: {
          status: "ready",
        },
        runner: {
          status: "private_evidence_required",
        },
        mergeQueue: {
          status: "blocked",
        },
      },
    },
    links: {
      self: "/api/agents/agent%2Fone/bootstrap?repo=elizaos%2Feliza",
      discovery: "/.well-known/eliza-hub.json",
      openapi: "/openapi.json",
      inbox: "/api/agents/agent%2Fone/inbox?repo=elizaos%2Feliza",
      cockpit: "/api/agents/agent%2Fone/cockpit?repo=elizaos%2Feliza",
      workContext:
        "/api/work-context?repo=elizaos%2Feliza&ownerAgentId=agent%2Fone",
      workPreflight: "/api/agents/agent%2Fone/work-preflight",
      workReservation: "/api/agents/agent%2Fone/work-reservation",
      submissionGate: "/api/agents/agent%2Fone/submission-gate",
      claimNext: "/api/agents/agent%2Fone/claim-next",
      claimAssignment: "/api/agents/agent%2Fone/claim-assignment",
      mergeTrain: "/api/merge-train?repo=elizaos%2Feliza",
      productionReadiness: "/api/production-readiness",
    },
    nextActions: [
      {
        id: "register_agent_identity",
        priority: 95,
        blocking: true,
        method: "POST",
        href: "/api/agent-identities",
        reason:
          "Strict agent identity registry policy is enabled and this agent is not known.",
      },
      {
        id: "preflight_before_branch",
        priority: 20,
        method: "POST",
        href: "/api/agents/agent%2Fone/work-preflight",
        reason:
          "Run work preflight before opening or updating an agent branch.",
      },
    ],
  };
}

function discoveryManifestFixture() {
  return {
    service: "eliza-merge-steward",
    version: "0.1.0",
    discoveryVersion: 1,
    auth: {
      requiredForApiRoutes: true,
      modes: ["oidc_bearer", "static_bearer"],
      oidc: {
        issuer: "https://cloud.example.invalid",
        audience: "eliza-merge-steward",
      },
      bearerHeader: "Authorization: Bearer <token>",
    },
    links: {
      self: "/.well-known/eliza-hub.json",
      openapi: "/openapi.json",
      githubParity: "/api/github-parity",
      productionReadiness: "/api/production-readiness",
      mergeQueue: "/api/merge-queue",
      mergeTrain: "/api/merge-train",
      queueItemActionPlan: "/api/queue/item/action-plan",
      agentBootstrapTemplate: "/api/agents/{agentId}/bootstrap",
      agentCockpitTemplate: "/api/agents/{agentId}/cockpit",
      agentActionPlanTemplate: "/api/agents/{agentId}/action-plan",
      agentInboxTemplate: "/api/agents/{agentId}/inbox",
    },
    surfaces: {
      git: { authority: "forgejo_native" },
      actions: { authority: "forgejo_actions" },
      projectBoard: { authority: "eliza_computed" },
      workPlanning: { authority: "eliza_steward" },
      mergeQueue: { authority: "eliza_steward" },
      discussions: { status: "not_supported_as_native_discussions" },
    },
    clientHints: {
      agentBranchNamespace: {
        required: true,
        prefix: "agent",
        pattern: "agent/{agentId}/",
      },
      agentRunReceipts: {
        required: true,
        verified: true,
        signatureAlgorithm: "hmac-sha256",
      },
      workItems: {
        requiredForAgentPrs: true,
        linkRequiredBeforeMerge: true,
        matchKeys: ["pullRequestId", "taskId", "issueId"],
        activeStates: ["backlog", "ready", "in_progress", "blocked"],
        terminalStates: ["done", "cancelled"],
      },
      agentIdentityRegistry: {
        required: true,
        knownAgentIdCount: 4,
        configuredAgentIdCount: 3,
        persistedActiveAgentIdCount: 2,
        identifier: "ownerAgentId",
      },
      mergeExecution: {
        integrationEnabled: true,
        integrationDryRun: false,
        liveIntegrationActive: true,
        executor: "local-git",
        batchingAllowed: true,
        maxBatchSize: 3,
        branchPrefix: "eliza-live-queue",
        branchPushEnabled: true,
        workerEnabled: true,
        workerLiveExecutionConfirmed: true,
        workerLeaseEnabled: true,
        workerLeaseIdConfigured: true,
        liveAgentMergesEvidenceGated: true,
        liveAgentMergesAllowedWithoutProductionEvidence: false,
        productionCutoverRequired: true,
      },
      productionEvidence: {
        artifactRootEnv: "ELIZA_ARTIFACT_ROOT",
        templateFile: "eliza-hub-production-evidence.template.json",
        assembledEvidenceFile: "eliza-hub-production-evidence.json",
        templateEndpoint: "/api/production-evidence-template",
        commands: {
          template:
            'node services/merge-steward/src/cli.js production-evidence-template > "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.template.json"',
          inventory:
            "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
          assemble:
            "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
          gate: 'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
        },
        strictGateRequired: true,
        inventoryMustPassBeforeAssemble: true,
        generatedEvidenceMustStayPrivate: true,
      },
    },
    productionReadiness: {
      status: "blocked_until_private_evidence_passes",
      currentUse: "demo_ready",
      productionReady: false,
      privateEvidenceRequired: true,
      link: "/api/production-readiness",
    },
    githubParity: {
      status: "forgejo_plus_eliza_not_full_github_parity",
      githubDropInReplacement: false,
      productionReadyWithoutPrivateEvidence: false,
      link: "/api/github-parity",
    },
  };
}
