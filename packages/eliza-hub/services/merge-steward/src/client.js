import { DISCOVERY_PATH } from "./discovery.js";

export class MergeStewardClientError extends Error {
  constructor(message, { status, statusText, body, url, method } = {}) {
    super(message);
    this.name = "MergeStewardClientError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.url = url;
    this.method = method;
  }
}

export class MergeStewardClient {
  constructor({
    baseUrl,
    token,
    fetchImpl = globalThis.fetch,
    userAgent = "eliza-merge-steward-client",
    defaultHeaders = {},
  } = {}) {
    if (!baseUrl) {
      throw new TypeError("MergeStewardClient requires baseUrl");
    }

    this.baseUrl = normalizeStewardBaseUrl(baseUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.defaultHeaders = defaultHeaders;
  }

  url(path, query = {}) {
    return resolveStewardUrl(this.baseUrl, path, query);
  }

  async request(method, path, { query, body, auth = true, headers } = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("MergeStewardClient requires a fetch implementation");
    }

    const requestHeaders = mergeHeaders(
      {
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
      this.defaultHeaders,
      headers,
    );

    if (auth && this.token && !hasHeader(requestHeaders, "authorization")) {
      requestHeaders.Authorization = `Bearer ${this.token}`;
    }

    const init = {
      method,
      headers: requestHeaders,
    };

    if (body !== undefined) {
      if (!hasHeader(requestHeaders, "content-type")) {
        requestHeaders["Content-Type"] = "application/json";
      }

      init.body = serializeBody(
        body,
        getHeader(requestHeaders, "content-type"),
      );
    }

    const url = this.url(path, query);
    const response = await this.fetchImpl(url, init);
    return parseResponse(response, { method, url });
  }

  get(path, options) {
    return this.request("GET", path, options);
  }

  post(path, body = undefined, options = {}) {
    return this.request("POST", path, { ...options, body });
  }

  patch(path, body = undefined, options = {}) {
    return this.request("PATCH", path, { ...options, body });
  }

  put(path, body = undefined, options = {}) {
    return this.request("PUT", path, { ...options, body });
  }

  delete(path, options) {
    return this.request("DELETE", path, options);
  }

  discover() {
    return this.get(DISCOVERY_PATH, { auth: false });
  }

  async getDiscoverySummary() {
    return summarizeDiscoveryManifest(await this.discover());
  }

  getOpenApi() {
    return this.get("/openapi.json", { auth: false });
  }

  getHealth() {
    return this.get("/health", { auth: false });
  }

  getReady() {
    return this.get("/ready", { auth: false });
  }

  getMetrics(options = {}) {
    return this.get("/metrics", options);
  }

  getWorkflowView(query = {}) {
    return this.get("/api/workflows", { query });
  }

  getGithubParity(query = {}) {
    return this.get("/api/github-parity", { query });
  }

  getProductionReadiness(query = {}) {
    return this.get("/api/production-readiness", { query });
  }

  async getProductionReadinessSummary(query = {}) {
    return summarizeProductionReadiness(
      await this.getProductionReadiness(query),
    );
  }

  getProductionCutover(query = {}) {
    return this.get("/api/production-cutover", { query });
  }

  async getProductionCutoverSummary(query = {}) {
    return summarizeProductionCutover(await this.getProductionCutover(query));
  }

  getProductionEvidenceTemplate(query = {}) {
    return this.get("/api/production-evidence-template", { query });
  }

  getProjectBoard(query = {}) {
    return this.get("/api/project-board", { query });
  }

  getMergeQueue(query = {}) {
    return this.get("/api/merge-queue", { query });
  }

  getMergeTrain(query = {}) {
    return this.get("/api/merge-train", { query });
  }

  simulateQueue(body = {}) {
    return this.post("/api/queue/simulate", body);
  }

  getReleaseReadiness(query = {}) {
    return this.get("/api/release-readiness", { query });
  }

  getRepositoryProtection(query = {}) {
    return this.get("/api/repository-protection", { query });
  }

  getAgentInsights(query = {}) {
    return this.get("/api/agent-insights", { query });
  }

  getAgentCapacity(query = {}) {
    return this.get("/api/agents", { query });
  }

  getAgentPerformance(query = {}) {
    return this.get("/api/agent-performance", { query });
  }

  getAgentRouting(query = {}) {
    return this.get("/api/agent-routing", { query });
  }

  analyzeCiFailures(body = {}) {
    return this.post("/api/ci/failure-analysis", body);
  }

  planValidation(body = {}) {
    return this.post("/api/ci/validation-plan", body);
  }

  planCiValidation(body = {}) {
    return this.planValidation(body);
  }

  getPullRequestBrief(body = {}) {
    return this.post("/api/pr/brief", body);
  }

  assignReviewers(body = {}) {
    return this.post("/api/review/assignment", body);
  }

  predictPatchConflicts(body = {}) {
    return this.post("/api/patch/conflict-prediction", body);
  }

  getReleaseNotes(query = {}) {
    return this.get("/api/releases/notes", { query });
  }

  buildReleaseNotes(body = {}) {
    return this.post("/api/releases/notes", body);
  }

  getCoordination(query = {}) {
    return this.get("/api/coordination", { query });
  }

  getFleetCoordination(query = {}) {
    return this.get("/api/fleet-coordination", { query });
  }

  getWorkContext(query = {}) {
    return this.get("/api/work-context", { query });
  }

  search(query = {}) {
    return this.get("/api/search", { query });
  }

  searchContext(body = {}) {
    return this.post("/api/search", body);
  }

  listWorkItems(query = {}) {
    return this.get("/api/work-items", { query });
  }

  getWorkItem(id) {
    return this.get("/api/work-items/item", { query: { id } });
  }

  upsertWorkItem(body = {}) {
    return this.post("/api/work-items", body);
  }

  transitionWorkItem(body = {}) {
    return this.post("/api/work-items/transition", body);
  }

  listWorkCycles(query = {}) {
    return this.get("/api/work-cycles", { query });
  }

  getWorkCycle(id) {
    return this.get("/api/work-cycles/item", { query: { id } });
  }

  upsertWorkCycle(body = {}) {
    return this.post("/api/work-cycles", body);
  }

  transitionWorkCycle(body = {}) {
    return this.post("/api/work-cycles/transition", body);
  }

  listWorkModules(query = {}) {
    return this.get("/api/work-modules", { query });
  }

  getWorkModule(id) {
    return this.get("/api/work-modules/item", { query: { id } });
  }

  upsertWorkModule(body = {}) {
    return this.post("/api/work-modules", body);
  }

  transitionWorkModule(body = {}) {
    return this.post("/api/work-modules/transition", body);
  }

  getWorkProgress(query = {}) {
    return this.get("/api/work-progress", { query });
  }

  listWorkViews(query = {}) {
    return this.get("/api/work-views", { query });
  }

  getWorkView(id) {
    return this.get("/api/work-views/item", { query: { id } });
  }

  upsertWorkView(body = {}) {
    return this.post("/api/work-views", body);
  }

  evaluateWorkView(query = {}) {
    return this.get("/api/work-views/evaluate", { query });
  }

  previewWorkView(body = {}) {
    return this.post("/api/work-views/evaluate", body);
  }

  transitionWorkView(body = {}) {
    return this.post("/api/work-views/transition", body);
  }

  listWorkPages(query = {}) {
    return this.get("/api/work-pages", { query });
  }

  getWorkPage(id) {
    return this.get("/api/work-pages/item", { query: { id } });
  }

  upsertWorkPage(body = {}) {
    return this.post("/api/work-pages", body);
  }

  transitionWorkPage(body = {}) {
    return this.post("/api/work-pages/transition", body);
  }

  getWorkDashboard(query = {}) {
    return this.get("/api/work-dashboard", { query });
  }

  getWorkIntake(query = {}) {
    return this.get("/api/work-intake", { query });
  }

  applyWorkIntake(body = {}) {
    return this.post("/api/work-intake/apply", body);
  }

  getAgentBootstrap(agentId, query = {}) {
    return this.get(`/api/agents/${encodeStewardSegment(agentId)}/bootstrap`, {
      query,
    });
  }

  async getAgentBootstrapSummary(agentId, query = {}) {
    return summarizeAgentBootstrap(
      await this.getAgentBootstrap(agentId, query),
    );
  }

  getAgentCockpit(agentId, query = {}) {
    return this.get(`/api/agents/${encodeStewardSegment(agentId)}/cockpit`, {
      query,
    });
  }

  getAgentActionPlan(agentId, body = {}) {
    return this.post(
      `/api/agents/${encodeStewardSegment(agentId)}/action-plan`,
      body,
    );
  }

  getAgentInbox(agentId, query = {}) {
    return this.get(`/api/agents/${encodeStewardSegment(agentId)}/inbox`, {
      query,
    });
  }

  getAgentSubmissionGate(agentId, body = {}) {
    return this.post(
      `/api/agents/${encodeStewardSegment(agentId)}/submission-gate`,
      body,
    );
  }

  getAgentWorkPreflight(agentId, body = {}) {
    return this.post(
      `/api/agents/${encodeStewardSegment(agentId)}/work-preflight`,
      body,
    );
  }

  reserveAgentWork(agentId, body = {}) {
    return this.post(
      `/api/agents/${encodeStewardSegment(agentId)}/work-reservation`,
      body,
    );
  }

  claimNext(agentId, body = {}) {
    return this.post(
      `/api/agents/${encodeStewardSegment(agentId)}/claim-next`,
      body,
    );
  }

  claimNextAgentWork(agentId, body = {}) {
    return this.claimNext(agentId, body);
  }

  claimAssignment(agentId, body = {}) {
    return this.post(
      `/api/agents/${encodeStewardSegment(agentId)}/claim-assignment`,
      body,
    );
  }

  claimSuggestedAssignment(agentId, body = {}) {
    return this.claimAssignment(agentId, body);
  }

  listApprovals(query = {}) {
    return this.get("/api/approvals", { query });
  }

  createApproval(body = {}) {
    return this.post("/api/approvals", body);
  }

  decideApproval(body = {}) {
    return this.post("/api/approvals/decide", body);
  }

  listHumanRequests(query = {}) {
    return this.get("/api/human-requests", { query });
  }

  getHumanRequest(id) {
    return this.get("/api/human-requests/item", { query: { id } });
  }

  createHumanRequest(body = {}) {
    return this.post("/api/human-requests", body);
  }

  respondToHumanRequest(body = {}) {
    return this.post("/api/human-requests/respond", body);
  }

  listSignals(query = {}) {
    return this.get("/api/signals", { query });
  }

  createSignal(body = {}) {
    return this.post("/api/signals", body);
  }

  consumeSignal(body = {}) {
    return this.post("/api/signals/consume", body);
  }

  listClaims(query = {}) {
    return this.get("/api/claims", { query });
  }

  getClaim(id) {
    return this.get("/api/claims/item", { query: { id } });
  }

  createClaim(body = {}) {
    return this.post("/api/claims", body);
  }

  renewClaim(body = {}) {
    return this.post("/api/claims/renew", body);
  }

  releaseClaim(body = {}) {
    return this.post("/api/claims/release", body);
  }

  transferClaim(body = {}) {
    return this.post("/api/claims/transfer", body);
  }

  listAgentIdentities(query = {}) {
    return this.get("/api/agent-identities", { query });
  }

  getAgentIdentity(agentId) {
    return this.get("/api/agent-identities/item", { query: { id: agentId } });
  }

  upsertAgentIdentity(body = {}) {
    return this.post("/api/agent-identities", body);
  }

  disableAgentIdentity(body = {}) {
    return this.post("/api/agent-identities/disable", body);
  }

  listRepoPolicies(query = {}) {
    return this.get("/api/repo-policies", { query });
  }

  getRepoPolicy(repo) {
    return this.get("/api/repo-policies/item", { query: { repo } });
  }

  upsertRepoPolicy(body = {}) {
    return this.post("/api/repo-policies", body);
  }

  listRuns(query = {}) {
    return this.get("/api/runs", { query });
  }

  createRun(body = {}) {
    return this.post("/api/runs", body);
  }

  getRun(runId) {
    return this.get(`/api/runs/${encodeStewardSegment(runId)}`);
  }

  getRunState(runId) {
    return this.get(`/api/runs/${encodeStewardSegment(runId)}/run-state`);
  }

  listRunNodes(runId, query = {}) {
    return this.get(`/api/runs/${encodeStewardSegment(runId)}/nodes`, {
      query,
    });
  }

  createRunNode(runId, body = {}) {
    return this.post(`/api/runs/${encodeStewardSegment(runId)}/nodes`, body);
  }

  listRunAttempts(runId, query = {}) {
    return this.get(`/api/runs/${encodeStewardSegment(runId)}/attempts`, {
      query,
    });
  }

  createRunAttempt(runId, body = {}) {
    return this.post(`/api/runs/${encodeStewardSegment(runId)}/attempts`, body);
  }

  listRunEvents(runId, query = {}) {
    return this.get(`/api/runs/${encodeStewardSegment(runId)}/events`, {
      query,
    });
  }

  createRunEvent(runId, body = {}) {
    return this.post(`/api/runs/${encodeStewardSegment(runId)}/events`, body);
  }

  getAttempt(id) {
    return this.get("/api/attempts/item", { query: { id } });
  }

  heartbeatAttempt(body = {}) {
    return this.post("/api/attempts/heartbeat", body);
  }

  finishAttempt(body = {}) {
    return this.post("/api/attempts/finish", body);
  }

  failAttempt(body = {}) {
    return this.post("/api/attempts/fail", body);
  }

  cancelAttempt(body = {}) {
    return this.post("/api/attempts/cancel", body);
  }

  claimStaleAttempts(body = {}) {
    return this.post("/api/attempts/claim-stale", body);
  }

  listQueue(query = {}) {
    return this.get("/api/queue", { query });
  }

  getQueueItem(id) {
    return this.get("/api/queue/item", { query: { id } });
  }

  getQueueItemRunState(id) {
    return this.get("/api/queue/item/run-state", { query: { id } });
  }

  getQueueItemActionPlan(id, query = {}) {
    return this.get("/api/queue/item/action-plan", { query: { id, ...query } });
  }

  claimQueueItem(body = {}) {
    return this.post("/api/queue/claim", body);
  }

  finishQueueItem(body = {}) {
    return this.post("/api/queue/item/finish", body);
  }

  failQueueItem(body = {}) {
    return this.post("/api/queue/item/fail", body);
  }

  overrideQueueItem(body = {}) {
    return this.post("/api/queue/item/override", body);
  }

  clearQueueItemOverride(body = {}) {
    return this.post("/api/queue/item/override/clear", body);
  }

  evaluateQueue(body = {}) {
    return this.post("/api/queue/evaluate", body);
  }

  evaluateQueueItem(body = {}) {
    return this.evaluateQueue(body);
  }

  scheduleQueue(body = {}) {
    return this.post("/api/queue/schedule", body);
  }

  scheduleQueueItems(body = {}) {
    return this.scheduleQueue(body);
  }

  getIntegrationPlan(query = {}) {
    return this.get("/api/queue/integration-plan", { query });
  }

  createIntegrationPlan(body = {}) {
    return this.post("/api/queue/integration-plan", body);
  }

  planIntegrationItems(body = {}) {
    return this.createIntegrationPlan(body);
  }

  executeIntegration(body = {}) {
    return this.post("/api/queue/integration-execution", body);
  }

  runOnce(body = {}) {
    return this.post("/api/queue/run-once", body);
  }

  runQueueOnce(body = {}) {
    return this.runOnce(body);
  }

  renderComment(body = {}) {
    return this.post("/api/comments/render", body);
  }

  sendForgejoWebhook(body, options = {}) {
    return this.post("/api/webhooks/forgejo", body, {
      auth: false,
      ...options,
    });
  }
}

export function createMergeStewardClient(options) {
  return new MergeStewardClient(options);
}

export function createMergeStewardClientFromEnv(
  env = globalThis.process?.env ?? {},
  options = {},
) {
  const baseUrl =
    options.baseUrl ?? env.MERGE_STEWARD_URL ?? env.ELIZA_MERGE_STEWARD_URL;
  const token =
    options.token ??
    env.MERGE_STEWARD_API_TOKEN ??
    env.MERGE_STEWARD_TOKEN ??
    env.ELIZA_MERGE_STEWARD_TOKEN;

  if (!baseUrl) {
    throw new TypeError(
      "MergeStewardClient env bootstrap requires MERGE_STEWARD_URL",
    );
  }

  return new MergeStewardClient({
    ...options,
    baseUrl,
    token,
  });
}

export function summarizeDiscoveryManifest(manifest = {}) {
  const auth = manifest?.auth ?? {};
  const clientHints = manifest?.clientHints ?? {};
  const branchNamespace = clientHints.agentBranchNamespace ?? {};
  const runReceipts = clientHints.agentRunReceipts ?? {};
  const workItems = clientHints.workItems ?? {};
  const identityRegistry = clientHints.agentIdentityRegistry ?? {};
  const mergeExecution = clientHints.mergeExecution ?? {};
  const productionEvidence = clientHints.productionEvidence ?? {};
  const productionEvidenceCommands = productionEvidence.commands ?? {};
  const surfaces = manifest?.surfaces ?? {};

  const liveExecutionConfigured =
    mergeExecution.liveIntegrationActive === true &&
    mergeExecution.workerEnabled === true &&
    mergeExecution.workerLiveExecutionConfirmed === true &&
    mergeExecution.workerLeaseIdConfigured === true;
  const liveAgentMergesRequireProductionEvidence =
    mergeExecution.liveAgentMergesEvidenceGated === true ||
    mergeExecution.productionCutoverRequired === true;

  return {
    service: manifest.service ?? null,
    version: manifest.version ?? null,
    discoveryVersion: manifest.discoveryVersion ?? null,
    auth: {
      requiredForApiRoutes: auth.requiredForApiRoutes === true,
      modes: arrayValue(auth.modes),
      bearerHeader: auth.bearerHeader ?? null,
      oidcIssuer: auth.oidc?.issuer ?? null,
      oidcAudience: auth.oidc?.audience ?? null,
    },
    routes: {
      discovery: manifest.links?.self ?? DISCOVERY_PATH,
      openapi: manifest.links?.openapi ?? "/openapi.json",
      agentBootstrapTemplate: manifest.links?.agentBootstrapTemplate ?? null,
      agentCockpitTemplate: manifest.links?.agentCockpitTemplate ?? null,
      agentActionPlanTemplate: manifest.links?.agentActionPlanTemplate ?? null,
      agentInboxTemplate: manifest.links?.agentInboxTemplate ?? null,
      mergeQueue: manifest.links?.mergeQueue ?? null,
      mergeTrain: manifest.links?.mergeTrain ?? null,
      queueItemActionPlan: manifest.links?.queueItemActionPlan ?? null,
      productionReadiness: manifest.links?.productionReadiness ?? null,
      githubParity: manifest.links?.githubParity ?? null,
    },
    surfaces: {
      gitAuthority: surfaces.git?.authority ?? null,
      actionsAuthority: surfaces.actions?.authority ?? null,
      projectBoardAuthority: surfaces.projectBoard?.authority ?? null,
      workPlanningAuthority: surfaces.workPlanning?.authority ?? null,
      mergeQueueAuthority: surfaces.mergeQueue?.authority ?? null,
      discussionsStatus: surfaces.discussions?.status ?? null,
    },
    agentPolicy: {
      branchNamespaceRequired: branchNamespace.required === true,
      branchNamespacePrefix: branchNamespace.prefix ?? null,
      branchNamespacePattern: branchNamespace.pattern ?? null,
      runReceiptRequired: runReceipts.required === true,
      runReceiptVerified: runReceipts.verified === true,
      runReceiptSignatureAlgorithm: runReceipts.signatureAlgorithm ?? null,
      workItemRequiredForAgentPrs: workItems.requiredForAgentPrs === true,
      workItemLinkRequiredBeforeMerge:
        workItems.linkRequiredBeforeMerge === true,
      workItemMatchKeys: arrayValue(workItems.matchKeys),
      workItemActiveStates: arrayValue(workItems.activeStates),
      workItemTerminalStates: arrayValue(workItems.terminalStates),
      identityRegistryRequired: identityRegistry.required === true,
      knownAgentIdCount: numberOrZero(identityRegistry.knownAgentIdCount),
      configuredAgentIdCount: numberOrZero(
        identityRegistry.configuredAgentIdCount,
      ),
      persistedActiveAgentIdCount: numberOrZero(
        identityRegistry.persistedActiveAgentIdCount,
      ),
      identityField: identityRegistry.identifier ?? null,
    },
    mergeExecution: {
      integrationEnabled: mergeExecution.integrationEnabled === true,
      integrationDryRun: mergeExecution.integrationDryRun !== false,
      liveIntegrationActive: mergeExecution.liveIntegrationActive === true,
      executor: mergeExecution.executor ?? null,
      batchingAllowed: mergeExecution.batchingAllowed === true,
      maxBatchSize: mergeExecution.maxBatchSize ?? null,
      branchPrefix: mergeExecution.branchPrefix ?? null,
      branchPushEnabled: mergeExecution.branchPushEnabled === true,
      workerEnabled: mergeExecution.workerEnabled === true,
      workerLiveExecutionConfirmed:
        mergeExecution.workerLiveExecutionConfirmed === true,
      workerLeaseEnabled: mergeExecution.workerLeaseEnabled === true,
      workerLeaseIdConfigured: mergeExecution.workerLeaseIdConfigured === true,
      liveExecutionConfigured,
      liveAgentMergesRequireProductionEvidence,
      liveAgentMergesAllowedWithoutProductionEvidence:
        mergeExecution.liveAgentMergesAllowedWithoutProductionEvidence === true,
      productionCutoverRequired:
        mergeExecution.productionCutoverRequired === true,
    },
    productionReadiness: {
      status: manifest.productionReadiness?.status ?? null,
      currentUse: manifest.productionReadiness?.currentUse ?? null,
      productionReady: manifest.productionReadiness?.productionReady === true,
      privateEvidenceRequired:
        manifest.productionReadiness?.privateEvidenceRequired === true,
      link: manifest.productionReadiness?.link ?? null,
    },
    productionEvidence: {
      artifactRootEnv: productionEvidence.artifactRootEnv ?? null,
      templateFile: productionEvidence.templateFile ?? null,
      assembledEvidenceFile: productionEvidence.assembledEvidenceFile ?? null,
      templateEndpoint: productionEvidence.templateEndpoint ?? null,
      templateCommand: productionEvidenceCommands.template ?? null,
      inventoryCommand: productionEvidenceCommands.inventory ?? null,
      assembleCommand: productionEvidenceCommands.assemble ?? null,
      gateCommand: productionEvidenceCommands.gate ?? null,
      strictGateRequired: productionEvidence.strictGateRequired === true,
      inventoryMustPassBeforeAssemble:
        productionEvidence.inventoryMustPassBeforeAssemble === true,
      generatedEvidenceMustStayPrivate:
        productionEvidence.generatedEvidenceMustStayPrivate === true,
    },
    githubParity: {
      status: manifest.githubParity?.status ?? null,
      githubDropInReplacement:
        manifest.githubParity?.githubDropInReplacement === true,
      productionReadyWithoutPrivateEvidence:
        manifest.githubParity?.productionReadyWithoutPrivateEvidence === true,
      link: manifest.githubParity?.link ?? null,
    },
  };
}

export function summarizeAgentBootstrap(payload = {}) {
  const bootstrap = payload.bootstrap ?? payload;
  const identity = bootstrap.identity ?? {};
  const policyHints = bootstrap.policyHints ?? {};
  const links = bootstrap.links ?? {};
  const snapshots = bootstrap.snapshots ?? {};
  const nextActions = arrayValue(bootstrap.nextActions);
  const blockingActions = nextActions.filter(
    (action) => action?.blocking === true,
  );
  const staleClaims = numberOrZero(snapshots.claims?.counts?.stale);
  const inboxNextActionCount = arrayValue(snapshots.inbox?.nextActions).length;
  const routingRecommendationCount = arrayValue(
    snapshots.routing?.recommendations,
  ).length;
  const workflowStatus =
    snapshots.workflowOperations?.status ??
    policyHints.workflowOperations?.status ??
    null;
  const controlPlaneBlocked = workflowStatus === "control_plane_blocked";
  const identityBlocked =
    identity.disabled === true ||
    identity.state === "disabled" ||
    identity.state === "unregistered_blocked";
  const startupBlocked =
    blockingActions.length > 0 || controlPlaneBlocked || identityBlocked;

  return {
    agentId: bootstrap.agentId ?? null,
    computedAt: bootstrap.computedAt ?? null,
    filters: {
      repo: bootstrap.filters?.repo ?? null,
      targetBranch: bootstrap.filters?.targetBranch ?? null,
      ownerAgentId:
        bootstrap.filters?.ownerAgentId ?? bootstrap.agentId ?? null,
    },
    identity: {
      required: identity.required === true,
      known: identity.known === true,
      configured: identity.configured === true,
      persistedActive: identity.persistedActive === true,
      disabled: identity.disabled === true,
      status: identity.status ?? null,
      state: identity.state ?? null,
      accepted: identity.known === true && identity.disabled !== true,
      registryKnownAgentIdCount: numberOrZero(
        identity.registrySummary?.knownAgentIdCount,
      ),
    },
    policy: {
      workReservationRequired: policyHints.workReservation?.required === true,
      reserveBeforePullRequest:
        policyHints.workReservation?.reserveBeforePullRequest === true,
      workItemRequired: policyHints.workItem?.required === true,
      linkWorkItemBeforePullRequest:
        policyHints.workItem?.linkBeforePullRequest === true,
      workItemMatchKeys: arrayValue(policyHints.workItem?.matchKeys),
      branchNamespaceRequired:
        policyHints.agentBranchNamespace?.required === true,
      branchNamespacePrefix: policyHints.agentBranchNamespace?.prefix ?? null,
      expectedBranchPrefix:
        policyHints.agentBranchNamespace?.expectedPrefix ?? null,
      runReceiptRequired: policyHints.agentRunReceipt?.required === true,
      runReceiptVerified: policyHints.agentRunReceipt?.verified === true,
      runReceiptSignatureAlgorithm:
        policyHints.agentRunReceipt?.signatureAlgorithm ?? null,
      identityRegistryRequired:
        policyHints.agentIdentityRegistry?.required === true,
      validationPlanBeforeRunning:
        policyHints.validationBudget?.planBeforeRunning === true,
      broadValidationBlockedByDefault:
        policyHints.validationBudget?.broadValidationBlockedByDefault === true,
    },
    submissionGate: {
      checkBeforePullRequest:
        policyHints.submissionGate?.checkBeforePullRequest === true,
      maxQueuedWork: policyHints.submissionGate?.maxQueuedWork ?? null,
      warnQueuedWork: policyHints.submissionGate?.warnQueuedWork ?? null,
      maxRecentSubmissions:
        policyHints.submissionGate?.maxRecentSubmissions ?? null,
      warnRecentSubmissions:
        policyHints.submissionGate?.warnRecentSubmissions ?? null,
      recentSubmissionWindowMinutes:
        policyHints.submissionGate?.recentSubmissionWindowMinutes ?? null,
    },
    work: {
      inboxCardCount: numberOrZero(snapshots.inbox?.counts?.cards),
      inboxNextActionCount,
      activeClaimCount: numberOrZero(snapshots.claims?.counts?.active),
      staleClaimCount: staleClaims,
      routingRecommendationCount,
      routingBlocked: Boolean(snapshots.routing?.blocked),
    },
    workflow: {
      status: workflowStatus,
      actionsStatus:
        snapshots.workflowOperations?.actions?.status ??
        policyHints.workflowOperations?.actionsStatus ??
        null,
      runnerStatus:
        snapshots.workflowOperations?.runner?.status ??
        policyHints.workflowOperations?.runnerStatus ??
        null,
      mergeQueueStatus:
        snapshots.workflowOperations?.mergeQueue?.status ??
        policyHints.workflowOperations?.mergeQueueStatus ??
        null,
      controlPlaneBlocked,
      nextActions: arrayValue(policyHints.workflowOperations?.nextActions),
    },
    mergeQueue: {
      integrationEnabled: policyHints.mergeQueue?.integrationEnabled === true,
      integrationDryRun: policyHints.mergeQueue?.integrationDryRun !== false,
      workerEnabled: policyHints.mergeQueue?.workerEnabled === true,
      trainStatus:
        policyHints.mergeQueue?.trainStatus ??
        snapshots.mergeTrain?.status ??
        null,
      trainPreflightStatus:
        policyHints.mergeQueue?.trainPreflightStatus ??
        snapshots.mergeTrain?.preflight?.status ??
        null,
      liveExecutionReady: policyHints.mergeQueue?.liveExecutionReady === true,
      dryRunReviewReady: policyHints.mergeQueue?.dryRunReviewReady === true,
    },
    nextActions: {
      count: nextActions.length,
      blockingCount: blockingActions.length,
      ids: nextActions.map((action) => action?.id).filter(Boolean),
      blockingIds: blockingActions.map((action) => action?.id).filter(Boolean),
      first: compactNextAction(nextActions[0]),
      firstBlocking: compactNextAction(blockingActions[0]),
    },
    startup: {
      blocked: startupBlocked,
      blockingReasons: [
        identityBlocked ? "agent_identity" : null,
        controlPlaneBlocked ? "control_plane" : null,
        staleClaims > 0 ? "stale_claims" : null,
        ...blockingActions.map((action) => action?.id).filter(Boolean),
      ].filter(Boolean),
      shouldPreflightBeforeBranch:
        Boolean(links.workPreflight) ||
        nextActions.some((action) => action?.id === "preflight_before_branch"),
      shouldPreviewClaim:
        Boolean(links.claimNext) ||
        nextActions.some((action) => action?.id === "preview_next_claim"),
    },
    links: {
      self: links.self ?? null,
      discovery: links.discovery ?? null,
      openapi: links.openapi ?? null,
      inbox: links.inbox ?? null,
      cockpit: links.cockpit ?? null,
      workContext: links.workContext ?? null,
      workPreflight: links.workPreflight ?? null,
      workReservation: links.workReservation ?? null,
      submissionGate: links.submissionGate ?? null,
      claimNext: links.claimNext ?? null,
      claimAssignment: links.claimAssignment ?? null,
      mergeTrain: links.mergeTrain ?? null,
      productionReadiness: links.productionReadiness ?? null,
    },
  };
}

export function summarizeProductionReadiness(payload = {}) {
  const readiness = payload.productionReadiness ?? payload;
  const summary = readiness.summary ?? {};
  const nextActions = arrayValue(readiness.nextActions);
  const blockedDomains = arrayValue(summary.blockedDomains);
  const passedDomains = arrayValue(summary.passedDomains);
  const domains = arrayValue(readiness.domains);
  const firstAction = nextActions[0] ?? null;

  return {
    status: readiness.status ?? null,
    currentUse: readiness.currentUse ?? null,
    checklistVersion: readiness.checklistVersion ?? null,
    generatedAt: readiness.generatedAt ?? null,
    productionReady: readiness.productionReady === true,
    privateEvidenceRequired: readiness.privateEvidenceRequired === true,
    privateEvidenceEvaluated: readiness.privateEvidenceEvaluated === true,
    gatePassed: summary.gatePassed === true,
    totalDomains: numberOrZero(summary.totalDomains ?? domains.length),
    passedDomainCount: passedDomains.length,
    blockedDomainCount: blockedDomains.length,
    passedDomains,
    blockedDomains,
    failedExtraChecks: arrayValue(summary.failedExtraChecks),
    evidenceBlocks: arrayValue(summary.evidenceBlocks),
    nextActionCount: nextActions.length,
    nextAction: compactProductionAction(firstAction),
    primaryHelperCommand: firstAction?.helper ?? null,
    nextHelperCommand:
      firstAction?.helperSteps?.[0]?.command ?? firstAction?.helper ?? null,
    nextHelperStep: compactProductionHelperStep(firstAction?.helperSteps?.[0]),
    domainStatuses: domains.map(compactProductionDomain),
    authoritativeGateCommand: readiness.authoritativeGate?.command ?? null,
  };
}

export function summarizeProductionCutover(payload = {}) {
  const cutover = payload.productionCutover ?? payload;
  const summary = cutover.summary ?? {};
  const guardrails = cutover.guardrails ?? {};
  const githubMigration = cutover.githubMigration ?? {};
  const orderedSteps = arrayValue(cutover.executionPlan?.orderedSteps);
  const firstStep = orderedSteps[0] ?? null;

  return {
    status: cutover.status ?? null,
    planVersion: cutover.planVersion ?? null,
    generatedAt: cutover.generatedAt ?? null,
    productionReady: cutover.productionReady === true,
    privateEvidenceRequired: cutover.privateEvidenceRequired === true,
    privateEvidenceEvaluated: cutover.privateEvidenceEvaluated === true,
    liveAgentMergesAllowed: guardrails.liveAgentMergesAllowed === true,
    githubMigrationReady: githubMigration.cutoverReady === true,
    githubMigration: {
      status: githubMigration.status ?? null,
      link: githubMigration.link ?? null,
      cutoverReady: githubMigration.cutoverReady === true,
      privateEvidenceEvaluated:
        githubMigration.privateEvidenceEvaluated === true,
      productionGatePassed: githubMigration.productionGatePassed === true,
      blockedSurfaceCount: numberOrZero(githubMigration.blockedSurfaceCount),
      readySurfaceCount: numberOrZero(githubMigration.readySurfaceCount),
      blockedSurfaces: arrayValue(githubMigration.blockedSurfaces),
      readySurfaces: arrayValue(githubMigration.readySurfaces),
      acceptedGapSurfaces: arrayValue(githubMigration.acceptedGapSurfaces),
    },
    mutatesState: guardrails.mutatesState === true,
    storesPrivateEvidence: guardrails.storesPrivateEvidence === true,
    finalGate: guardrails.finalGate ?? null,
    nextPhase: cutover.nextPhase
      ? {
          id: cutover.nextPhase.id ?? null,
          title: cutover.nextPhase.title ?? null,
          blockers: arrayValue(cutover.nextPhase.blockers),
          firstAction: compactProductionAction(cutover.nextPhase.firstAction),
        }
      : null,
    blockedPhaseCount: numberOrZero(summary.blockedPhases),
    blockedDomains: arrayValue(summary.blockedDomains),
    passedDomains: arrayValue(summary.passedDomains),
    gatePassed: summary.gatePassed === true,
    orderedStepCount: orderedSteps.length,
    firstStep: compactProductionStep(firstStep),
    primaryHelperCommand: firstStep?.helper ?? null,
    firstHelperCommand:
      firstStep?.helperSteps?.[0]?.command ?? firstStep?.helper ?? null,
    firstHelperStep: compactProductionHelperStep(firstStep?.helperSteps?.[0]),
    assemblyCommands: arrayValue(cutover.executionPlan?.assemblyCommands),
    finalVerificationCommands: arrayValue(
      cutover.executionPlan?.finalVerificationCommands,
    ),
    labels: arrayValue(cutover.labels),
  };
}

export function resolveStewardUrl(baseUrl, path, query = {}) {
  const base = normalizeStewardBaseUrl(baseUrl);
  const pathValue = path === undefined || path === null ? "" : String(path);

  if (/^[a-z][a-z\d+.-]*:/i.test(pathValue)) {
    throw new TypeError("Steward request path must be relative to baseUrl");
  }

  const relativePath = pathValue.replace(/^\/+/, "");
  const pathOnly = relativePath.split(/[?#]/, 1)[0];

  if (pathOnly.split("/").includes("..")) {
    throw new TypeError("Steward request path cannot traverse above baseUrl");
  }

  const url = new URL(`${base.pathname}${relativePath}`, base.origin);
  applyQuery(url, query);
  return url;
}

export function encodeStewardSegment(value) {
  if (value === undefined || value === null || value === "") {
    throw new TypeError("Steward path segment must be present");
  }

  return encodeURIComponent(String(value));
}

function arrayValue(value) {
  return Array.isArray(value)
    ? value.filter((item) => item !== undefined && item !== null)
    : [];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function compactNextAction(action) {
  if (!action) {
    return null;
  }

  return {
    id: action.id ?? null,
    priority: action.priority ?? null,
    blocking: action.blocking === true,
    method: action.method ?? null,
    href: action.href ?? null,
    reason: action.reason ?? null,
  };
}

function compactProductionDomain(domain) {
  return {
    id: domain?.id ?? null,
    title: domain?.title ?? null,
    status: domain?.status ?? null,
    evidenceBlock: domain?.evidenceBlock ?? null,
    helper: domain?.helper ?? null,
    helperStepCount: arrayValue(domain?.helperSteps).length,
    missingEvidenceCount: arrayValue(domain?.gateCheck?.errors).length,
  };
}

function compactProductionAction(action) {
  if (!action) return null;

  return {
    id: action.id ?? null,
    status: action.status ?? null,
    evidenceBlock: action.evidenceBlock ?? null,
    helper: action.helper ?? null,
    helperSteps: arrayValue(action.helperSteps).map(
      compactProductionHelperStep,
    ),
    nextAction: action.nextAction ?? null,
    missingEvidence: arrayValue(action.missingEvidence),
  };
}

function compactProductionStep(step) {
  if (!step) return null;

  return {
    phaseId: step.phaseId ?? null,
    domainId: step.domainId ?? null,
    title: step.title ?? null,
    evidenceBlock: step.evidenceBlock ?? null,
    helper: step.helper ?? null,
    helperSteps: arrayValue(step.helperSteps).map(compactProductionHelperStep),
    missingEvidence: arrayValue(step.missingEvidence),
    verification: step.verification ?? null,
  };
}

function compactProductionHelperStep(step) {
  if (!step) return null;

  return {
    id: step.id ?? null,
    command: step.command ?? null,
    requires: arrayValue(step.requires),
    produces: step.produces ?? null,
    description: step.description ?? null,
  };
}

function normalizeStewardBaseUrl(baseUrl) {
  const url = baseUrl instanceof URL ? new URL(baseUrl.href) : new URL(baseUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("MergeStewardClient baseUrl must use http or https");
  }

  url.search = "";
  url.hash = "";

  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

function applyQuery(url, query = {}) {
  if (!query) {
    return;
  }

  const entries =
    query instanceof URLSearchParams ? query.entries() : Object.entries(query);

  for (const [key, value] of entries) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }
}

function mergeHeaders(...sources) {
  const headers = {};

  for (const source of sources) {
    if (!source) {
      continue;
    }

    if (typeof Headers !== "undefined" && source instanceof Headers) {
      source.forEach((value, key) => {
        headers[key] = value;
      });
      continue;
    }

    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null) {
        headers[key] = value;
      }
    }
  }

  return headers;
}

function hasHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === normalizedName,
  );
}

function getHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === normalizedName,
  );
  return key ? headers[key] : undefined;
}

function serializeBody(body, contentType = "") {
  if (
    typeof body === "string" ||
    body instanceof Uint8Array ||
    (typeof URLSearchParams !== "undefined" &&
      body instanceof URLSearchParams) ||
    (typeof FormData !== "undefined" && body instanceof FormData)
  ) {
    return body;
  }

  if (contentType.toLowerCase().includes("application/json")) {
    return JSON.stringify(body);
  }

  return body;
}

async function parseResponse(response, { method, url } = {}) {
  const text = typeof response.text === "function" ? await response.text() : "";
  const contentType = response.headers?.get?.("content-type") || "";
  const body = text ? parseResponseBody(text, contentType) : null;

  if (!response.ok) {
    throw new MergeStewardClientError(
      `Merge Steward request failed with ${response.status}`,
      {
        status: response.status,
        statusText: response.statusText,
        body,
        url: String(url),
        method,
      },
    );
  }

  return body;
}

function parseResponseBody(text, contentType) {
  if (contentType.toLowerCase().includes("application/json")) {
    return JSON.parse(text);
  }

  return text;
}
