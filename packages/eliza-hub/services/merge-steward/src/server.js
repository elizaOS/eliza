import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { renderQueueComment } from "./comments.js";
import { loadConfig, validateRuntimeConfig } from "./config.js";
import { buildDiscoveryManifest, DISCOVERY_PATH } from "./discovery.js";
import { ForgejoClient } from "./forgejo-client.js";
import {
  buildGithubParityMatrix,
  GITHUB_PARITY_PATH,
} from "./github-parity.js";
import { LocalGitIntegrationExecutor } from "./local-git-executor.js";
import { renderMergeStewardMetrics } from "./metrics.js";
import { createOidcVerifier } from "./oidc-auth.js";
import { PostgresQueueStore } from "./postgres-store.js";
import {
  buildProductionEvidenceTemplate,
  PRODUCTION_EVIDENCE_TEMPLATE_PATH,
} from "./production-evidence-template.js";
import {
  buildProductionCutoverPlan,
  buildProductionReadiness,
  PRODUCTION_CUTOVER_PATH,
  PRODUCTION_READINESS_PATH,
} from "./production-readiness.js";
import { MergeSteward } from "./steward.js";
import { JsonFileQueueStore } from "./store.js";
import { runQueueWorker } from "./worker.js";

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
});

const METRICS_HEADERS = Object.freeze({
  "content-type": "text/plain; version=0.0.4; charset=utf-8",
});

const OPENAPI_CONTRACT_URL = new URL("../openapi.json", import.meta.url);

let openApiContractTextPromise;

export function createServer({
  config = loadConfig(),
  logger = console,
  steward = createSteward({ config, logger }),
  authVerifier = createOidcVerifier(config.oidc),
} = {}) {
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      let apiAuth = { ok: true, identity: { kind: "none" } };

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          ok: true,
          service: "eliza-merge-steward",
        });
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const readiness = await checkReadiness({ config, steward });
        return sendJson(response, readiness.ok ? 200 : 503, readiness);
      }

      if (request.method === "GET" && url.pathname === "/openapi.json") {
        return sendText(
          response,
          200,
          await readOpenApiContractText(),
          JSON_HEADERS,
        );
      }

      if (request.method === "GET" && url.pathname === DISCOVERY_PATH) {
        return sendJson(
          response,
          200,
          buildDiscoveryManifest({
            config,
            version: await readOpenApiContractVersion(),
            agentIdentityRegistry:
              await steward.getAgentIdentityRegistrySummary(),
          }),
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/metrics" &&
        config.metrics?.enabled === true
      ) {
        if (config.metrics?.authRequired === true) {
          const auth = await authorizeApiRequest(request, config, authVerifier);
          if (!auth.ok) {
            return sendJson(
              response,
              auth.statusCode,
              { error: auth.reason },
              auth.headers,
            );
          }
        }

        const readiness = await checkReadiness({ config, steward });
        const metrics = await renderMergeStewardMetrics({
          config,
          steward,
          readiness,
        });
        return sendText(response, 200, metrics, METRICS_HEADERS);
      }

      if (
        url.pathname.startsWith("/api/") &&
        url.pathname !== "/api/webhooks/forgejo"
      ) {
        apiAuth = await authorizeApiRequest(request, config, authVerifier);
        if (!apiAuth.ok) {
          return sendJson(
            response,
            apiAuth.statusCode,
            { error: apiAuth.reason },
            apiAuth.headers,
          );
        }
      }

      if (request.method === "POST" && url.pathname === "/api/queue/evaluate") {
        const body = await readJson(request, config);
        const decision = await steward.evaluateItem(body.item ?? body);
        return sendJson(response, 200, { decision });
      }

      if (request.method === "POST" && url.pathname === "/api/queue/schedule") {
        const body = await readJson(request, config);
        const queue = await steward.scheduleItems(body.items ?? []);
        return sendJson(response, 200, { queue });
      }

      if (request.method === "POST" && url.pathname === "/api/queue/simulate") {
        const body = await readJson(request, config);
        const simulation = await steward.simulateQueue(body);
        return sendJson(response, 200, { simulation });
      }

      if (request.method === "GET" && url.pathname === "/api/queue") {
        return sendJson(response, 200, await steward.listQueue());
      }

      if (request.method === "GET" && url.pathname === "/api/coordination") {
        return sendJson(response, 200, {
          summary: await steward.getCoordinationSummary({
            now: url.searchParams.get("now") ?? undefined,
          }),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/fleet-coordination"
      ) {
        return sendJson(response, 200, {
          coordinationContract: await steward.getFleetCoordination({
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            now: url.searchParams.get("now") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/work-context") {
        return sendJson(response, 200, {
          workContext: await steward.getWorkContext({
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            query:
              url.searchParams.get("q") ??
              url.searchParams.get("query") ??
              undefined,
            now: url.searchParams.get("now") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/search") {
        return sendJson(response, 200, {
          search: await steward.search({
            query:
              url.searchParams.get("q") ??
              url.searchParams.get("query") ??
              undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            kinds:
              url.searchParams.getAll("kind").length > 0
                ? url.searchParams.getAll("kind")
                : url.searchParams.getAll("kinds"),
            now: url.searchParams.get("now") ?? undefined,
          }),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/search") {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          search: await steward.search({
            query: body.query ?? body.q,
            repo: body.repo,
            ownerAgentId: body.ownerAgentId,
            targetBranch: body.targetBranch,
            kinds: body.kinds ?? body.kind,
            documents: body.documents,
            limits: body.limits,
            now: body.now,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/work-items") {
        return sendJson(response, 200, {
          workItems: await steward.listWorkItems({
            repo: url.searchParams.get("repo") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/work-items/item") {
        const id =
          url.searchParams.get("id") ?? url.searchParams.get("workItemId");
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_item_id" });
        }

        const workItem = await steward.getWorkItem(id);
        return sendJson(
          response,
          workItem ? 200 : 404,
          workItem ? { workItem } : { error: "work_item_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/work-items") {
        const body = await readJson(request, config);
        const workItem = await steward.upsertWorkItem(
          body.workItem ?? body.item ?? body,
          {
            actorId: body.actorId ?? body.updatedBy ?? body.createdBy,
            now: body.now,
          },
        );
        return sendJson(response, 200, { workItem });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/work-items/transition"
      ) {
        const body = await readJson(request, config);
        const id = body.id ?? body.workItemId;
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_item_id" });
        }

        const workItem = await steward.transitionWorkItem(id, {
          state: body.state,
          transitionedBy: body.transitionedBy ?? body.actorId,
          reason: body.reason,
          now: body.now,
        });
        return sendJson(
          response,
          workItem ? 200 : 404,
          workItem ? { workItem } : { error: "work_item_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/work-cycles") {
        return sendJson(response, 200, {
          workCycles: await steward.listWorkCycles({
            repo: url.searchParams.get("repo") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
          }),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/work-cycles/item"
      ) {
        const id =
          url.searchParams.get("id") ??
          url.searchParams.get("cycleId") ??
          url.searchParams.get("workCycleId");
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_cycle_id" });
        }

        const workCycle = await steward.getWorkCycle(id);
        return sendJson(
          response,
          workCycle ? 200 : 404,
          workCycle ? { workCycle } : { error: "work_cycle_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/work-cycles") {
        const body = await readJson(request, config);
        const workCycle = await steward.upsertWorkCycle(
          body.workCycle ?? body.cycle ?? body,
          {
            actorId: body.actorId ?? body.updatedBy ?? body.createdBy,
            now: body.now,
          },
        );
        return sendJson(response, 200, { workCycle });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/work-cycles/transition"
      ) {
        const body = await readJson(request, config);
        const id = body.id ?? body.cycleId ?? body.workCycleId;
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_cycle_id" });
        }

        const workCycle = await steward.transitionWorkCycle(id, {
          state: body.state,
          transitionedBy: body.transitionedBy ?? body.actorId,
          reason: body.reason,
          now: body.now,
        });
        return sendJson(
          response,
          workCycle ? 200 : 404,
          workCycle ? { workCycle } : { error: "work_cycle_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/work-modules") {
        return sendJson(response, 200, {
          workModules: await steward.listWorkModules({
            repo: url.searchParams.get("repo") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
          }),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/work-modules/item"
      ) {
        const id =
          url.searchParams.get("id") ??
          url.searchParams.get("moduleId") ??
          url.searchParams.get("workModuleId");
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_module_id" });
        }

        const workModule = await steward.getWorkModule(id);
        return sendJson(
          response,
          workModule ? 200 : 404,
          workModule ? { workModule } : { error: "work_module_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/work-modules") {
        const body = await readJson(request, config);
        const workModule = await steward.upsertWorkModule(
          body.workModule ?? body.module ?? body,
          {
            actorId: body.actorId ?? body.updatedBy ?? body.createdBy,
            now: body.now,
          },
        );
        return sendJson(response, 200, { workModule });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/work-modules/transition"
      ) {
        const body = await readJson(request, config);
        const id = body.id ?? body.moduleId ?? body.workModuleId;
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_module_id" });
        }

        const workModule = await steward.transitionWorkModule(id, {
          state: body.state,
          transitionedBy: body.transitionedBy ?? body.actorId,
          reason: body.reason,
          now: body.now,
        });
        return sendJson(
          response,
          workModule ? 200 : 404,
          workModule ? { workModule } : { error: "work_module_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/work-progress") {
        return sendJson(response, 200, {
          workProgress: await steward.getWorkProgress({
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            now: url.searchParams.get("now") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/work-views") {
        return sendJson(response, 200, {
          workViews: await steward.listWorkViews({
            repo: url.searchParams.get("repo") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/work-views/item") {
        const id =
          url.searchParams.get("id") ??
          url.searchParams.get("viewId") ??
          url.searchParams.get("workViewId");
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_view_id" });
        }

        const workView = await steward.getWorkView(id);
        return sendJson(
          response,
          workView ? 200 : 404,
          workView ? { workView } : { error: "work_view_not_found" },
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/work-views/evaluate"
      ) {
        const id =
          url.searchParams.get("id") ??
          url.searchParams.get("viewId") ??
          url.searchParams.get("workViewId");
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_view_id" });
        }

        const workViewEvaluation = await steward.evaluateWorkView({
          id,
          repo: url.searchParams.get("repo") ?? undefined,
          ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
          now: url.searchParams.get("now") ?? undefined,
          maxItems: url.searchParams.get("maxItems") ?? undefined,
          maxPages: url.searchParams.get("maxPages") ?? undefined,
        });
        return sendJson(
          response,
          workViewEvaluation ? 200 : 404,
          workViewEvaluation
            ? { workViewEvaluation }
            : { error: "work_view_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/work-views") {
        const body = await readJson(request, config);
        const workView = await steward.upsertWorkView(
          body.workView ?? body.view ?? body,
          {
            actorId: body.actorId ?? body.updatedBy ?? body.createdBy,
            now: body.now,
          },
        );
        return sendJson(response, 200, { workView });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/work-views/evaluate"
      ) {
        const body = await readJson(request, config);
        const id = body.id ?? body.viewId ?? body.workViewId;
        const view =
          body.workView ??
          body.view ??
          (body.title || body.kind || body.filters || body.query
            ? body
            : undefined);
        if (!id && !view) {
          return sendJson(response, 400, { error: "missing_work_view" });
        }

        const workViewEvaluation = await steward.evaluateWorkView({
          id,
          view,
          repo: body.repo,
          ownerAgentId: body.ownerAgentId,
          now: body.now,
          maxItems: body.maxItems,
          maxPages: body.maxPages,
        });
        return sendJson(
          response,
          workViewEvaluation ? 200 : 404,
          workViewEvaluation
            ? { workViewEvaluation }
            : { error: "work_view_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/work-views/transition"
      ) {
        const body = await readJson(request, config);
        const id = body.id ?? body.viewId ?? body.workViewId;
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_view_id" });
        }

        const workView = await steward.transitionWorkView(id, {
          state: body.state,
          transitionedBy: body.transitionedBy ?? body.actorId,
          reason: body.reason,
          now: body.now,
        });
        return sendJson(
          response,
          workView ? 200 : 404,
          workView ? { workView } : { error: "work_view_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/work-pages") {
        return sendJson(response, 200, {
          workPages: await steward.listWorkPages({
            repo: url.searchParams.get("repo") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
            workItemId: url.searchParams.get("workItemId") ?? undefined,
            cycleId: url.searchParams.get("cycleId") ?? undefined,
            moduleId: url.searchParams.get("moduleId") ?? undefined,
            taskId: url.searchParams.get("taskId") ?? undefined,
            issueId: url.searchParams.get("issueId") ?? undefined,
            pullRequestId: url.searchParams.get("pullRequestId") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/work-pages/item") {
        const id =
          url.searchParams.get("id") ??
          url.searchParams.get("pageId") ??
          url.searchParams.get("workPageId");
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_page_id" });
        }

        const workPage = await steward.getWorkPage(id);
        return sendJson(
          response,
          workPage ? 200 : 404,
          workPage ? { workPage } : { error: "work_page_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/work-pages") {
        const body = await readJson(request, config);
        const workPage = await steward.upsertWorkPage(
          body.workPage ?? body.page ?? body,
          {
            actorId: body.actorId ?? body.updatedBy ?? body.createdBy,
            now: body.now,
          },
        );
        return sendJson(response, 200, { workPage });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/work-pages/transition"
      ) {
        const body = await readJson(request, config);
        const id = body.id ?? body.pageId ?? body.workPageId;
        if (!id) {
          return sendJson(response, 400, { error: "missing_work_page_id" });
        }

        const workPage = await steward.transitionWorkPage(id, {
          state: body.state,
          transitionedBy: body.transitionedBy ?? body.actorId,
          reason: body.reason,
          now: body.now,
        });
        return sendJson(
          response,
          workPage ? 200 : 404,
          workPage ? { workPage } : { error: "work_page_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/work-dashboard") {
        return sendJson(response, 200, {
          workDashboard: await steward.getWorkDashboard({
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            now: url.searchParams.get("now") ?? undefined,
            maxItemIds: url.searchParams.get("maxItemIds") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/work-intake") {
        return sendJson(response, 200, {
          workIntake: await steward.getWorkIntakePlan({
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            now: url.searchParams.get("now") ?? undefined,
            maxActions: url.searchParams.get("maxActions") ?? undefined,
          }),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/work-intake/apply"
      ) {
        const body = await readJson(request, config);
        if (body.confirm !== true) {
          return sendJson(response, 400, { error: "confirmation_required" });
        }

        return sendJson(response, 200, {
          workIntake: await steward.applyWorkIntakePlan({
            confirm: true,
            repo: body.repo,
            ownerAgentId: body.ownerAgentId,
            actionIds: body.actionIds,
            actorId: body.actorId,
            now: body.now,
            maxActions: body.maxActions,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/agent-insights") {
        return sendJson(response, 200, {
          insights: await steward.getAgentInsights({
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/agents") {
        return sendJson(response, 200, {
          agents: await steward.getAgentCapacity({
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            since: url.searchParams.get("since") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
            maxSuggestions: url.searchParams.get("maxSuggestions") ?? undefined,
          }),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/agent-identities"
      ) {
        return sendJson(response, 200, {
          agents: await steward.listRegisteredAgents({
            status: url.searchParams.get("status") ?? undefined,
            tenantId: url.searchParams.get("tenantId") ?? undefined,
            source: url.searchParams.get("source") ?? undefined,
          }),
          summary: await steward.getAgentIdentityRegistrySummary(),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/agent-identities/item"
      ) {
        const id =
          url.searchParams.get("id") ?? url.searchParams.get("agentId");
        if (!id) {
          return sendJson(response, 400, { error: "missing_agent_id" });
        }

        const agent = await steward.getRegisteredAgent(id);
        return sendJson(
          response,
          agent ? 200 : 404,
          agent ? { agent } : { error: "agent_identity_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/agent-identities"
      ) {
        const body = await readJson(request, config);
        const operator = authorizeRegistryOperator(
          apiAuth,
          config,
          body.registeredBy ?? body.actorId ?? body.operatorId,
        );
        if (!operator.ok) {
          return sendJson(response, 403, { error: operator.reason });
        }

        const agent = await steward.upsertRegisteredAgent(body.agent ?? body, {
          registeredBy: operator.actorId,
          now: body.now,
        });
        return sendJson(response, 200, {
          agent,
          summary: await steward.getAgentIdentityRegistrySummary(),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/agent-identities/disable"
      ) {
        const body = await readJson(request, config);
        const id = body.id ?? body.agentId;
        if (!id) {
          return sendJson(response, 400, { error: "missing_agent_id" });
        }

        const operator = authorizeRegistryOperator(
          apiAuth,
          config,
          body.disabledBy ?? body.actorId ?? body.operatorId,
        );
        if (!operator.ok) {
          return sendJson(response, 403, { error: operator.reason });
        }

        const agent = await steward.disableRegisteredAgent(id, {
          disabledBy: operator.actorId,
          reason: body.reason,
          now: body.now,
        });
        return sendJson(
          response,
          agent ? 200 : 404,
          agent
            ? {
                agent,
                summary: await steward.getAgentIdentityRegistrySummary(),
              }
            : { error: "agent_identity_not_found" },
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/agent-performance"
      ) {
        return sendJson(response, 200, {
          performance: await steward.getAgentPerformance({
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            since: url.searchParams.get("since") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/agent-routing") {
        return sendJson(response, 200, {
          routing: await steward.getAgentRouting({
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            since: url.searchParams.get("since") ?? undefined,
            maxRecommendations:
              url.searchParams.get("maxRecommendations") ?? undefined,
          }),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/ci/failure-analysis"
      ) {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          analysis: await steward.analyzeCiFailures({
            queueItemId: body.queueItemId,
            item: body.item,
            checks: body.checks,
            logs: body.logs,
            now: body.now,
          }),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/ci/validation-plan"
      ) {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          validationPlan: await steward.buildValidationPlan({
            queueItemId: body.queueItemId,
            item: body.item,
            changedFiles: body.changedFiles,
            affectedPackages: body.affectedPackages,
            commands: body.commands,
            requestedCommands: body.requestedCommands,
            limits: body.limits,
            allowBroadCommands: body.allowBroadCommands === true,
            now: body.now,
          }),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/pr/brief") {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          brief: await steward.buildPullRequestBrief({
            queueItemId: body.queueItemId,
            item: body.item,
            ciAnalysis: body.ciAnalysis,
            validationPlan: body.validationPlan,
            validationCommands: body.validationCommands ?? body.commands,
            requestedValidationCommands:
              body.requestedValidationCommands ?? body.requestedCommands,
            allowBroadValidationCommands:
              body.allowBroadValidationCommands === true ||
              body.allowBroadCommands === true,
            validationLimits: body.validationLimits ?? body.limits,
            submissionGate: body.submissionGate,
            reviewAssignment: body.reviewAssignment,
            requireWorkReservation:
              body.requireWorkReservation === true ||
              body.requireReservation === true,
            now: body.now,
          }),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/review/assignment"
      ) {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          assignment: await steward.assignReviewers({
            queueItemId: body.queueItemId,
            item: body.item,
            queueItem: body.queueItem,
            proposedItem: body.proposedItem ?? body.item,
            repo: body.repo,
            targetBranch: body.targetBranch,
            ownerAgentId: body.ownerAgentId,
            changedFiles: body.changedFiles ?? body.paths,
            affectedPackages: body.affectedPackages ?? body.packages,
            limits: body.limits,
            maxSuggestions: body.maxSuggestions,
            now: body.now,
          }),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/patch/conflict-prediction"
      ) {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          prediction: await steward.predictPatchConflicts({
            proposedItem: body.proposedItem ?? body.item,
            repo: body.repo,
            targetBranch: body.targetBranch,
            ownerAgentId: body.ownerAgentId,
            changedFiles: body.changedFiles ?? body.paths,
            affectedPackages: body.affectedPackages ?? body.packages,
            targetCommitsBehind: body.targetCommitsBehind,
            limits: body.limits,
            now: body.now,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/releases/notes") {
        return sendJson(response, 200, {
          notes: await steward.buildReleaseNotes({
            repo: url.searchParams.get("repo") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            from: url.searchParams.get("from") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
            version: url.searchParams.get("version") ?? undefined,
            title: url.searchParams.get("title") ?? undefined,
            now: url.searchParams.get("now") ?? undefined,
          }),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/releases/notes") {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          notes: await steward.buildReleaseNotes({
            items: body.items,
            repo: body.repo,
            targetBranch: body.targetBranch,
            from: body.from,
            to: body.to,
            version: body.version,
            title: body.title,
            now: body.now,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/workflows") {
        const includeReadiness = url.searchParams.get("readiness") !== "false";
        const now = url.searchParams.get("now") ?? undefined;
        const repo = url.searchParams.get("repo") ?? undefined;
        const targetBranch = url.searchParams.get("targetBranch") ?? undefined;
        const ownerAgentId = url.searchParams.get("ownerAgentId") ?? undefined;
        const [readiness, mergeTrain] = await Promise.all([
          includeReadiness ? checkReadiness({ config, steward }) : null,
          steward.getMergeTrainPlan({
            now,
            repo,
            targetBranch,
            maxLanes: 3,
            maxLaneItems: 10,
          }),
        ]);
        return sendJson(response, 200, {
          workflow: await steward.getWorkflowView({
            now,
            repo,
            targetBranch,
            ownerAgentId,
            readiness,
            mergeTrain,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === GITHUB_PARITY_PATH) {
        return sendJson(response, 200, {
          parity: buildGithubParityMatrix(),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === PRODUCTION_READINESS_PATH
      ) {
        return sendJson(response, 200, {
          productionReadiness: buildProductionReadiness(),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === PRODUCTION_CUTOVER_PATH
      ) {
        return sendJson(response, 200, {
          productionCutover: buildProductionCutoverPlan(),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === PRODUCTION_EVIDENCE_TEMPLATE_PATH
      ) {
        return sendJson(response, 200, {
          productionEvidenceTemplate: buildProductionEvidenceTemplate(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/project-board") {
        const includeReadiness = url.searchParams.get("readiness") !== "false";
        const includeEmptyColumns =
          url.searchParams.get("emptyColumns") !== "false";
        const readiness = includeReadiness
          ? await checkReadiness({ config, steward })
          : null;
        return sendJson(response, 200, {
          board: await steward.getProjectBoard({
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            includeEmptyColumns,
            readiness,
          }),
        });
      }

      const agentBootstrapRoute = parseAgentBootstrapRoute(url.pathname);
      if (request.method === "GET" && agentBootstrapRoute) {
        const includeReadiness = url.searchParams.get("readiness") !== "false";
        const readiness = includeReadiness
          ? await checkReadiness({ config, steward })
          : null;
        return sendJson(response, 200, {
          bootstrap: await steward.getAgentBootstrap({
            ownerAgentId: agentBootstrapRoute.agentId,
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            since: url.searchParams.get("since") ?? undefined,
            maxRecommendations:
              url.searchParams.get("maxRecommendations") ?? undefined,
            readiness,
          }),
        });
      }

      const agentCockpitRoute = parseAgentCockpitRoute(url.pathname);
      if (request.method === "GET" && agentCockpitRoute) {
        const includeReadiness = url.searchParams.get("readiness") !== "false";
        const readiness = includeReadiness
          ? await checkReadiness({ config, steward })
          : null;
        return sendJson(response, 200, {
          cockpit: await steward.getAgentCockpit({
            ownerAgentId: agentCockpitRoute.agentId,
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            query:
              url.searchParams.get("q") ??
              url.searchParams.get("query") ??
              undefined,
            maxRecommendations:
              url.searchParams.get("maxRecommendations") ?? undefined,
            maxSearchResults:
              url.searchParams.get("maxSearchResults") ?? undefined,
            readiness,
          }),
        });
      }

      const agentActionPlanRoute = parseAgentActionPlanRoute(url.pathname);
      if (request.method === "POST" && agentActionPlanRoute) {
        const body = await readJson(request, config);
        const includeReadiness = body.readiness !== false;
        const readiness = includeReadiness
          ? await checkReadiness({ config, steward })
          : null;
        return sendJson(response, 200, {
          actionPlan: await steward.getAgentActionPlan({
            ownerAgentId: agentActionPlanRoute.agentId,
            repo: body.repo,
            targetBranch: body.targetBranch,
            proposedItem: body.proposedItem ?? body.item,
            changedFiles: body.changedFiles ?? body.paths,
            affectedPackages: body.affectedPackages ?? body.packages,
            validationCommands: body.validationCommands ?? body.commands,
            requestedValidationCommands:
              body.requestedValidationCommands ?? body.requestedCommands,
            allowBroadValidationCommands:
              body.allowBroadValidationCommands === true ||
              body.allowBroadCommands === true,
            validationLimits: body.validationLimits,
            searchQuery: body.searchQuery ?? body.query ?? body.q,
            searchKinds: body.searchKinds ?? body.kinds,
            searchLimits: body.searchLimits,
            documents: body.documents,
            targetCommitsBehind: body.targetCommitsBehind,
            requireWorkItem:
              body.requireWorkItem === true || body.requireWorkLink === true
                ? true
                : undefined,
            requireWorkReservation:
              body.requireWorkReservation === true ||
              body.requireReservation === true
                ? true
                : undefined,
            requireAgentBranchNamespace:
              body.requireAgentBranchNamespace === true ||
              body.requireBranchNamespace === true
                ? true
                : undefined,
            requireAgentIdentityRegistry:
              body.requireAgentIdentityRegistry === true ||
              body.requireIdentityRegistry === true
                ? true
                : undefined,
            agentBranchNamespacePrefix:
              body.agentBranchNamespacePrefix ?? body.branchNamespacePrefix,
            limits: body.limits,
            planLimits: body.planLimits,
            since: body.since,
            maxRecommendations: body.maxRecommendations,
            readiness,
            now: body.now,
          }),
        });
      }

      const agentInboxRoute = parseAgentInboxRoute(url.pathname);
      if (request.method === "GET" && agentInboxRoute) {
        const includeReadiness = url.searchParams.get("readiness") !== "false";
        const readiness = includeReadiness
          ? await checkReadiness({ config, steward })
          : null;
        return sendJson(response, 200, {
          inbox: await steward.getAgentInbox({
            ownerAgentId: agentInboxRoute.agentId,
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            readiness,
          }),
        });
      }

      const agentSubmissionGateRoute = parseAgentSubmissionGateRoute(
        url.pathname,
      );
      if (request.method === "POST" && agentSubmissionGateRoute) {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          gate: await steward.getAgentSubmissionGate({
            ownerAgentId: agentSubmissionGateRoute.agentId,
            repo: body.repo,
            targetBranch: body.targetBranch,
            proposedItem: body.proposedItem ?? body.item,
            validationPlan: body.validationPlan,
            validationCommands: body.validationCommands ?? body.commands,
            requestedValidationCommands:
              body.requestedValidationCommands ?? body.requestedCommands,
            allowBroadValidationCommands:
              body.allowBroadValidationCommands === true ||
              body.allowBroadCommands === true,
            validationLimits: body.validationLimits ?? body.limits,
            requireWorkItem:
              body.requireWorkItem === true || body.requireWorkLink === true
                ? true
                : undefined,
            requireWorkReservation:
              body.requireWorkReservation === true ||
              body.requireReservation === true
                ? true
                : undefined,
            requireAgentBranchNamespace:
              body.requireAgentBranchNamespace === true ||
              body.requireBranchNamespace === true
                ? true
                : undefined,
            requireAgentIdentityRegistry:
              body.requireAgentIdentityRegistry === true ||
              body.requireIdentityRegistry === true
                ? true
                : undefined,
            agentBranchNamespacePrefix:
              body.agentBranchNamespacePrefix ?? body.branchNamespacePrefix,
            limits: body.limits,
            since: body.since,
            now: body.now,
          }),
        });
      }

      const agentWorkPreflightRoute = parseAgentWorkPreflightRoute(
        url.pathname,
      );
      if (request.method === "POST" && agentWorkPreflightRoute) {
        const body = await readJson(request, config);
        return sendJson(response, 200, {
          preflight: await steward.getAgentWorkPreflight({
            ownerAgentId: agentWorkPreflightRoute.agentId,
            repo: body.repo,
            targetBranch: body.targetBranch,
            proposedItem: body.proposedItem ?? body.item,
            changedFiles: body.changedFiles ?? body.paths,
            affectedPackages: body.affectedPackages ?? body.packages,
            requireAgentBranchNamespace:
              body.requireAgentBranchNamespace === true ||
              body.requireBranchNamespace === true
                ? true
                : undefined,
            agentBranchNamespacePrefix:
              body.agentBranchNamespacePrefix ?? body.branchNamespacePrefix,
            limits: body.limits,
            now: body.now,
          }),
        });
      }

      const agentWorkReservationRoute = parseAgentWorkReservationRoute(
        url.pathname,
      );
      if (request.method === "POST" && agentWorkReservationRoute) {
        const body = await readJson(request, config);
        const agentAuth = await authorizeAgentAction(
          apiAuth,
          config,
          steward,
          agentWorkReservationRoute.agentId,
        );
        if (!agentAuth.ok) {
          return sendJson(response, 403, { error: agentAuth.reason });
        }

        const reservation = await steward.reserveAgentWork({
          ownerAgentId: agentAuth.agentId,
          repo: body.repo,
          targetBranch: body.targetBranch,
          proposedItem: body.proposedItem ?? body.item,
          changedFiles: body.changedFiles ?? body.paths,
          affectedPackages: body.affectedPackages ?? body.packages,
          limits: body.limits,
          ttlMs: body.ttlMs,
          dryRun: body.dryRun === true,
          allowWatch: body.allowWatch !== false,
          maxClaims: body.maxClaims,
          createWorkItem: body.createWorkItem !== false,
          workItem: body.workItem,
          now: body.now,
        });
        const statusCode =
          reservation.reserved || reservation.dryRun ? 200 : 409;
        return sendJson(response, statusCode, { reservation });
      }

      const agentClaimNextRoute = parseAgentClaimNextRoute(url.pathname);
      if (request.method === "POST" && agentClaimNextRoute) {
        const body = await readJson(request, config);
        const agentAuth = await authorizeAgentAction(
          apiAuth,
          config,
          steward,
          agentClaimNextRoute.agentId,
        );
        if (!agentAuth.ok) {
          return sendJson(response, 403, { error: agentAuth.reason });
        }

        const result = await steward.claimNextAgentWork({
          ownerAgentId: agentAuth.agentId,
          repo: body.repo,
          targetBranch: body.targetBranch,
          action: body.action,
          resourceKind: body.resourceKind,
          includeOtherOwners: body.includeOtherOwners === true,
          dryRun: body.dryRun === true,
          ttlMs: body.ttlMs,
          now: body.now,
        });
        const statusCode =
          result.claimed || result.dryRun
            ? 200
            : result.reason === "no_claimable_work"
              ? 404
              : 409;
        return sendJson(response, statusCode, result);
      }

      const agentClaimAssignmentRoute = parseAgentClaimAssignmentRoute(
        url.pathname,
      );
      if (request.method === "POST" && agentClaimAssignmentRoute) {
        const body = await readJson(request, config);
        const agentAuth = await authorizeAgentAction(
          apiAuth,
          config,
          steward,
          agentClaimAssignmentRoute.agentId,
        );
        if (!agentAuth.ok) {
          return sendJson(response, 403, { error: agentAuth.reason });
        }

        const result = await steward.claimSuggestedAgentAssignment({
          ownerAgentId: agentAuth.agentId,
          repo: body.repo,
          targetBranch: body.targetBranch,
          dryRun: body.dryRun === true,
          ttlMs: body.ttlMs,
          now: body.now,
        });
        const statusCode =
          result.claimed || result.dryRun
            ? 200
            : result.reason === "no_suggested_assignment"
              ? 404
              : 409;
        return sendJson(response, statusCode, result);
      }

      if (request.method === "GET" && url.pathname === "/api/merge-queue") {
        return sendJson(response, 200, {
          mergeQueue: await steward.getMergeQueueSummary({
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/merge-train") {
        return sendJson(response, 200, {
          mergeTrain: await steward.getMergeTrainPlan({
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            maxLanes: url.searchParams.get("maxLanes") ?? undefined,
            maxLaneItems: url.searchParams.get("maxLaneItems") ?? undefined,
          }),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/release-readiness"
      ) {
        const includeReadiness = url.searchParams.get("readiness") !== "false";
        const readiness = includeReadiness
          ? await checkReadiness({ config, steward })
          : null;
        return sendJson(response, 200, {
          releaseReadiness: await steward.getReleaseReadiness({
            now: url.searchParams.get("now") ?? undefined,
            repo: url.searchParams.get("repo") ?? undefined,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            readiness,
            requireLiveMerge: queryBoolean(url, "requireLiveMerge"),
            requireRoutableAgent: queryBoolean(url, "requireRoutableAgent"),
            requireRepositoryProtection: queryBoolean(
              url,
              "requireRepositoryProtection",
            ),
            includeRepositoryProtection: queryBoolean(
              url,
              "includeRepositoryProtection",
            ),
            requireLiveProtection: queryBoolean(url, "requireLiveProtection"),
          }),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/repository-protection"
      ) {
        const repo = url.searchParams.get("repo");
        if (!repo) {
          return sendJson(response, 400, { error: "missing_repo" });
        }

        return sendJson(response, 200, {
          repositoryProtection: await steward.getRepositoryProtection({
            now: url.searchParams.get("now") ?? undefined,
            repo,
            targetBranch: url.searchParams.get("targetBranch") ?? undefined,
            requireLive: queryBoolean(url, "requireLive"),
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/runs") {
        const status = url.searchParams.get("status") ?? undefined;
        const queueItemId = url.searchParams.get("queueItemId") ?? undefined;
        return sendJson(response, 200, {
          runs: await steward.listRuns({ status, queueItemId }),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await readJson(request, config);
        const run = await steward.upsertRun(body.run ?? body);
        return sendJson(response, 200, { run });
      }

      const runRoute = parseRunRoute(url.pathname);
      if (runRoute && request.method === "GET" && runRoute.child === null) {
        const run = await steward.getRun(runRoute.id);
        return sendJson(
          response,
          run ? 200 : 404,
          run ? { run } : { error: "run_not_found" },
        );
      }

      if (
        runRoute &&
        request.method === "GET" &&
        runRoute.child === "run-state"
      ) {
        const runState = await steward.getRunState(runRoute.id);
        return sendJson(
          response,
          runState ? 200 : 404,
          runState ? { runState } : { error: "run_not_found" },
        );
      }

      if (runRoute && request.method === "GET" && runRoute.child === "nodes") {
        return sendJson(response, 200, {
          nodes: await steward.listRunNodes(runRoute.id),
        });
      }

      if (runRoute && request.method === "POST" && runRoute.child === "nodes") {
        const body = await readJson(request, config);
        const node = await steward.upsertRunNode(
          runRoute.id,
          body.node ?? body,
        );
        return sendJson(
          response,
          node ? 200 : 404,
          node ? { node } : { error: "run_not_found" },
        );
      }

      if (
        runRoute &&
        request.method === "GET" &&
        runRoute.child === "attempts"
      ) {
        return sendJson(response, 200, {
          attempts: await steward.listAttempts({
            runId: runRoute.id,
            nodeId: url.searchParams.get("nodeId") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
            ownerId: url.searchParams.get("ownerId") ?? undefined,
          }),
        });
      }

      if (
        runRoute &&
        request.method === "POST" &&
        runRoute.child === "attempts"
      ) {
        const body = await readJson(request, config);
        const attempt = await steward.startAttempt(
          runRoute.id,
          body.attempt ?? body,
        );
        return sendJson(
          response,
          attempt ? 200 : 404,
          attempt ? { attempt } : { error: "run_not_found" },
        );
      }

      if (runRoute && request.method === "GET" && runRoute.child === "events") {
        return sendJson(response, 200, {
          events: await steward.listRunEvents(runRoute.id, {
            afterSeq: url.searchParams.get("afterSeq") ?? undefined,
          }),
        });
      }

      if (
        runRoute &&
        request.method === "POST" &&
        runRoute.child === "events"
      ) {
        const body = await readJson(request, config);
        const event = await steward.appendRunEvent(
          runRoute.id,
          body.event ?? body,
        );
        return sendJson(
          response,
          event ? 200 : 404,
          event ? { event } : { error: "run_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/attempts/item") {
        const id = url.searchParams.get("id");
        if (!id) {
          return sendJson(response, 400, { error: "missing_attempt_id" });
        }

        const attempt = await steward.getAttempt(id);
        return sendJson(
          response,
          attempt ? 200 : 404,
          attempt ? { attempt } : { error: "attempt_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/attempts/heartbeat"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_attempt_id" });
        }

        const attempt = await steward.heartbeatAttempt(body.id, {
          ownerId: body.ownerId,
        });
        return sendJson(
          response,
          attempt ? 200 : 404,
          attempt
            ? { attempt }
            : { error: "attempt_not_found_or_owner_mismatch" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/attempts/finish"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_attempt_id" });
        }

        const attempt = await steward.finishAttempt(body.id, {
          output: body.output,
        });
        return sendJson(
          response,
          attempt ? 200 : 404,
          attempt ? { attempt } : { error: "attempt_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/attempts/fail") {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_attempt_id" });
        }

        const attempt = await steward.failAttempt(body.id, {
          error: body.error,
          output: body.output,
          retryAfterMs: body.retryAfterMs,
        });
        return sendJson(
          response,
          attempt ? 200 : 404,
          attempt ? { attempt } : { error: "attempt_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/attempts/cancel"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_attempt_id" });
        }

        const attempt = await steward.cancelAttempt(body.id, {
          reason: body.reason,
          cancelledBy: body.cancelledBy,
        });
        return sendJson(
          response,
          attempt ? 200 : 404,
          attempt ? { attempt } : { error: "attempt_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/attempts/claim-stale"
      ) {
        const body = await readJson(request, config);
        return sendJson(
          response,
          200,
          await steward.claimStaleAttempt({
            workerId: body.workerId,
            now: body.now,
            staleAfterMs: body.staleAfterMs,
          }),
        );
      }

      if (request.method === "GET" && url.pathname === "/api/approvals") {
        const status = url.searchParams.get("status") ?? undefined;
        return sendJson(response, 200, {
          approvals: await steward.listApprovals({ status }),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/approvals") {
        const body = await readJson(request, config);
        const requestedApproval = body.approval ?? body;
        const actorAuth = authorizeActorAction(
          apiAuth,
          config,
          requestedApproval.requestedBy,
        );
        if (!actorAuth.ok) {
          return sendJson(response, 403, { error: actorAuth.reason });
        }

        const approval = await steward.requestApproval({
          ...requestedApproval,
          requestedBy: actorAuth.actorId ?? requestedApproval.requestedBy,
        });
        return sendJson(
          response,
          approval ? 200 : 404,
          approval ? { approval } : { error: "run_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/approvals/decide"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_approval_id" });
        }
        const actorAuth = authorizeActorAction(apiAuth, config, body.decidedBy);
        if (!actorAuth.ok) {
          return sendJson(response, 403, { error: actorAuth.reason });
        }
        const existingApproval = await steward.getApproval(body.id);
        if (
          existingApproval &&
          !actorCanDecideApproval(
            apiAuth,
            config,
            actorAuth.actorId,
            existingApproval,
          )
        ) {
          return sendJson(response, 403, {
            error: "approval_actor_not_allowed",
          });
        }

        const approval = await steward.decideApproval(body.id, {
          approved: body.approved === true,
          decidedBy: actorAuth.actorId,
          note: body.note,
          decision: body.decision,
        });
        return sendJson(
          response,
          approval ? 200 : 404,
          approval ? { approval } : { error: "approval_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/human-requests") {
        const status = url.searchParams.get("status") ?? undefined;
        const runId = url.searchParams.get("runId") ?? undefined;
        return sendJson(response, 200, {
          requests: await steward.listHumanRequests({ status, runId }),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/human-requests/item"
      ) {
        const id = url.searchParams.get("id");
        if (!id) {
          return sendJson(response, 400, { error: "missing_human_request_id" });
        }

        const humanRequest = await steward.getHumanRequest(id);
        return sendJson(
          response,
          humanRequest ? 200 : 404,
          humanRequest
            ? { request: humanRequest }
            : { error: "human_request_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/human-requests") {
        const body = await readJson(request, config);
        const humanRequest = await steward.requestHumanInput(
          body.request ?? body,
        );
        return sendJson(
          response,
          humanRequest ? 200 : 404,
          humanRequest ? { request: humanRequest } : { error: "run_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/human-requests/respond"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_human_request_id" });
        }
        const actorAuth = authorizeActorAction(
          apiAuth,
          config,
          body.respondedBy,
        );
        if (!actorAuth.ok) {
          return sendJson(response, 403, { error: actorAuth.reason });
        }

        const humanRequest = await steward.respondHumanRequest(body.id, {
          response: body.response,
          respondedBy: actorAuth.actorId,
          status: body.status,
        });
        return sendJson(
          response,
          humanRequest ? 200 : 404,
          humanRequest
            ? { request: humanRequest }
            : { error: "human_request_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/signals") {
        return sendJson(response, 200, {
          signals: await steward.listSignals({
            runId: url.searchParams.get("runId") ?? undefined,
            correlationKey: url.searchParams.get("correlationKey") ?? undefined,
            type: url.searchParams.get("type") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
          }),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/signals") {
        const body = await readJson(request, config);
        return sendJson(
          response,
          200,
          await steward.appendSignal(body.signal ?? body),
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/signals/consume"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_signal_id" });
        }

        const signal = await steward.consumeSignal(body.id, {
          consumerId: body.consumerId,
        });
        return sendJson(
          response,
          signal ? 200 : 404,
          signal ? { signal } : { error: "signal_not_found" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/claims") {
        return sendJson(response, 200, {
          claims: await steward.listAgentClaims({
            repo: url.searchParams.get("repo") ?? undefined,
            ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
            resourceKind: url.searchParams.get("resourceKind") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/claims/item") {
        const id = url.searchParams.get("id");
        if (!id) {
          return sendJson(response, 400, { error: "missing_claim_id" });
        }

        const claim = await steward.getAgentClaim(id);
        return sendJson(
          response,
          claim ? 200 : 404,
          claim ? { claim } : { error: "claim_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/claims") {
        const body = await readJson(request, config);
        const requestedClaim = body.claim ?? body;
        const agentAuth = await authorizeAgentAction(
          apiAuth,
          config,
          steward,
          requestedClaim.ownerAgentId,
        );
        if (!agentAuth.ok) {
          return sendJson(response, 403, { error: agentAuth.reason });
        }

        const result = await steward.claimAgentWork(
          {
            ...requestedClaim,
            ownerAgentId: agentAuth.agentId,
          },
          {
            ttlMs: body.ttlMs,
            now: body.now,
          },
        );
        return sendJson(response, result.claimed ? 200 : 409, result);
      }

      if (request.method === "POST" && url.pathname === "/api/claims/renew") {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_claim_id" });
        }
        const agentAuth = await authorizeAgentAction(
          apiAuth,
          config,
          steward,
          body.ownerAgentId,
        );
        if (!agentAuth.ok) {
          return sendJson(response, 403, { error: agentAuth.reason });
        }

        const claim = await steward.renewAgentClaim(body.id, {
          ownerAgentId: agentAuth.agentId,
          expiresAt: body.expiresAt,
          ttlMs: body.ttlMs,
          now: body.now,
        });
        return sendJson(
          response,
          claim ? 200 : 404,
          claim ? { claim } : { error: "claim_not_found_or_owner_mismatch" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/claims/release") {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_claim_id" });
        }
        const agentAuth = await authorizeAgentAction(
          apiAuth,
          config,
          steward,
          body.ownerAgentId,
        );
        if (!agentAuth.ok) {
          return sendJson(response, 403, { error: agentAuth.reason });
        }

        const claim = await steward.releaseAgentClaim(body.id, {
          ownerAgentId: agentAuth.agentId,
          reason: body.reason,
          now: body.now,
        });
        return sendJson(
          response,
          claim ? 200 : 404,
          claim ? { claim } : { error: "claim_not_found_or_owner_mismatch" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/claims/transfer"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_claim_id" });
        }
        if (!body.toOwnerAgentId) {
          return sendJson(response, 400, {
            error: "missing_to_owner_agent_id",
          });
        }
        const fromAgentAuth = await authorizeAgentAction(
          apiAuth,
          config,
          steward,
          body.fromOwnerAgentId,
        );
        if (!fromAgentAuth.ok) {
          return sendJson(response, 403, { error: fromAgentAuth.reason });
        }
        if (
          config.policy?.requireAgentIdentityRegistryForAgentPrs === true &&
          !(await registeredAgentId(config, steward, body.toOwnerAgentId))
        ) {
          return sendJson(response, 403, {
            error: "agent_identity_unregistered",
          });
        }

        const claim = await steward.transferAgentClaim(body.id, {
          fromOwnerAgentId: fromAgentAuth.agentId,
          toOwnerAgentId: body.toOwnerAgentId,
          reason: body.reason,
          expiresAt: body.expiresAt,
          ttlMs: body.ttlMs,
          now: body.now,
        });
        return sendJson(
          response,
          claim ? 200 : 404,
          claim ? { claim } : { error: "claim_not_found_or_owner_mismatch" },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/repo-policies") {
        return sendJson(response, 200, {
          policies: await steward.listRepoPolicies(),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/repo-policies/item"
      ) {
        const repo = url.searchParams.get("repo");
        if (!repo) {
          return sendJson(response, 400, { error: "missing_repo" });
        }

        const policy = await steward.getRepoPolicy(repo);
        return sendJson(
          response,
          policy ? 200 : 404,
          policy ? { policy } : { error: "repo_policy_not_found" },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/repo-policies") {
        const body = await readJson(request, config);
        const policy = await steward.upsertRepoPolicy(body.policy ?? body);
        return sendJson(response, 200, { policy });
      }

      if (request.method === "POST" && url.pathname === "/api/queue/claim") {
        const body = await readJson(request, config);
        return sendJson(
          response,
          200,
          await steward.claimNextQueueItem({ workerId: body.workerId }),
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/queue/integration-plan"
      ) {
        return sendJson(response, 200, await steward.planIntegration());
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/queue/integration-plan"
      ) {
        const body = await readJson(request, config);
        return sendJson(
          response,
          200,
          await steward.planIntegration(body.items ?? []),
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/queue/integration-execution"
      ) {
        const body = await readJson(request, config);
        return sendJson(
          response,
          200,
          await steward.executeIntegration(body.items, {
            confirmed: body.confirm === true,
          }),
        );
      }

      if (request.method === "POST" && url.pathname === "/api/queue/run-once") {
        const body = await readJson(request, config);
        return sendJson(
          response,
          200,
          await steward.runQueueOnce({
            workerId: body.workerId,
            confirmed: body.confirm === true,
          }),
        );
      }

      if (request.method === "GET" && url.pathname === "/api/queue/item") {
        const id = url.searchParams.get("id");
        if (!id) {
          return sendJson(response, 400, { error: "missing_queue_item_id" });
        }

        const item = await steward.getQueueItem(id);
        return sendJson(
          response,
          item ? 200 : 404,
          item ? { item } : { error: "queue_item_not_found" },
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/queue/item/run-state"
      ) {
        const id = url.searchParams.get("id");
        if (!id) {
          return sendJson(response, 400, { error: "missing_queue_item_id" });
        }

        const runState = await steward.getQueueItemRunState(id);
        return sendJson(
          response,
          runState ? 200 : 404,
          runState ? { runState } : { error: "queue_item_not_found" },
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/queue/item/action-plan"
      ) {
        const id = url.searchParams.get("id");
        if (!id) {
          return sendJson(response, 400, { error: "missing_queue_item_id" });
        }

        const includeReadiness = url.searchParams.get("readiness") !== "false";
        const readiness = includeReadiness
          ? await checkReadiness({ config, steward })
          : null;
        const queueItemActionPlan = await steward.getQueueItemActionPlan(id, {
          ownerAgentId: url.searchParams.get("ownerAgentId") ?? undefined,
          now: url.searchParams.get("now") ?? undefined,
          readiness,
        });
        return sendJson(
          response,
          queueItemActionPlan ? 200 : 404,
          queueItemActionPlan
            ? { queueItemActionPlan }
            : { error: "queue_item_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/queue/item/finish"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_queue_item_id" });
        }

        const item = await steward.finishQueueItem(body.id, {
          state: body.state,
        });
        return sendJson(
          response,
          item ? 200 : 404,
          item ? { item } : { error: "queue_item_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/queue/item/fail"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_queue_item_id" });
        }

        const item = await steward.failQueueItem(body.id, {
          error: body.error,
        });
        return sendJson(
          response,
          item ? 200 : 404,
          item ? { item } : { error: "queue_item_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/queue/item/override"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_queue_item_id" });
        }
        const actorAuth = authorizeActorAction(
          apiAuth,
          config,
          body.approvedBy,
        );
        if (!actorAuth.ok) {
          return sendJson(response, 403, { error: actorAuth.reason });
        }
        if (!actorAuth.actorId || !body.reason) {
          return sendJson(response, 400, {
            error: "missing_override_approval",
          });
        }

        const result = await steward.overrideQueueItem(body.id, {
          approvedBy: actorAuth.actorId,
          reason: body.reason,
          blockers: body.blockers,
          expiresAt: body.expiresAt,
          now: body.now,
        });
        return sendJson(
          response,
          result ? 200 : 404,
          result ?? { error: "queue_item_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/queue/item/override/clear"
      ) {
        const body = await readJson(request, config);
        if (!body.id) {
          return sendJson(response, 400, { error: "missing_queue_item_id" });
        }
        const actorAuth = authorizeActorAction(apiAuth, config, body.clearedBy);
        if (!actorAuth.ok) {
          return sendJson(response, 403, { error: actorAuth.reason });
        }
        if (!actorAuth.actorId || !body.reason) {
          return sendJson(response, 400, {
            error: "missing_override_clearance",
          });
        }

        const result = await steward.clearQueueItemOverride(body.id, {
          clearedBy: actorAuth.actorId,
          reason: body.reason,
          now: body.now,
        });
        return sendJson(
          response,
          result ? 200 : 404,
          result ?? { error: "queue_item_not_found" },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/comments/render"
      ) {
        const body = await readJson(request, config);
        const comment = renderQueueComment(body);
        return sendJson(response, 200, { comment });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/webhooks/forgejo"
      ) {
        const rawBody = await readRawBody(request, config);
        const result = await steward.handleWebhookDelivery({
          headers: request.headers,
          rawBody,
        });
        return sendJson(response, 202, result);
      }

      return sendJson(response, 404, {
        error: "not_found",
      });
    } catch (error) {
      // error-policy:J1 HTTP boundary: errors typed with a 4xx statusCode at
      // the throw site keep their status and message; everything else is an
      // internal failure and returns an opaque 500 so internals never leak.
      const statusCode =
        Number.isInteger(error?.statusCode) &&
        error.statusCode >= 400 &&
        error.statusCode <= 499
          ? error.statusCode
          : 500;
      logger.error?.("[MergeStewardServer] request failed", {
        error,
        statusCode,
      });
      if (statusCode === 500) {
        return sendJson(response, 500, { error: "internal_error" });
      }
      return sendJson(response, statusCode, {
        error: "bad_request",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}

export function createSteward({
  config = loadConfig(),
  logger = console,
} = {}) {
  const store = createQueueStore(config);
  const enrichmentClient = createEnrichmentClient(config);
  const feedbackClient = createFeedbackClient(config);
  const integrationClient = createIntegrationClient(config);
  const forgejoClient = createForgejoApiClient(config);
  return new MergeSteward({
    config,
    store,
    enrichmentClient,
    feedbackClient,
    integrationClient,
    forgejoClient,
    logger,
  });
}

export function createQueueStore(config) {
  if (config.databaseUrl) {
    return new PostgresQueueStore({ connectionString: config.databaseUrl });
  }
  if (config.queueStorePath) {
    return new JsonFileQueueStore(config.queueStorePath);
  }
  return undefined;
}

export async function checkReadiness({
  config = loadConfig(),
  steward = createSteward({ config }),
} = {}) {
  const checks = [];

  try {
    const queue = await steward.listQueue();
    checks.push({
      name: "queue_store",
      ok: true,
      backend: queueStoreBackend(config),
      items: queue.items.length,
      running: queue.running.length,
      scheduled: queue.scheduled.length,
    });
  } catch (error) {
    // error-policy:J4 /ready exists to report the failing check as ok:false;
    // this is the designed degrade
    checks.push({
      name: "queue_store",
      ok: false,
      backend: queueStoreBackend(config),
      error: error instanceof Error ? error.message : "queue_store_unavailable",
    });
  }

  if (config.worker?.enabled === true && config.worker?.leaseEnabled === true) {
    const store = steward.store;
    try {
      if (!store || typeof store.getWorkerLease !== "function") {
        throw new Error("worker_lease_store_unavailable");
      }
      const lease = await store.getWorkerLease(config.worker.leaseId);
      checks.push({
        name: "worker_lease",
        ok: true,
        enabled: true,
        leaseId: config.worker.leaseId,
        ownerId: lease?.ownerId ?? null,
        status: lease?.status ?? null,
        expiresAt: lease?.expiresAt ?? null,
      });
    } catch (error) {
      // error-policy:J4 /ready exists to report the failing check as ok:false;
      // this is the designed degrade
      checks.push({
        name: "worker_lease",
        ok: false,
        enabled: true,
        leaseId: config.worker.leaseId,
        error:
          error instanceof Error ? error.message : "worker_lease_unavailable",
      });
    }
  }

  const apiAuthToken = config.apiAuth?.tokenEnv
    ? process.env[config.apiAuth.tokenEnv]
    : null;
  const apiAuthReady =
    config.oidc?.enabled === true ||
    config.apiAuth?.required !== true ||
    Boolean(apiAuthToken);
  checks.push({
    name: "control_api_auth",
    ok: apiAuthReady,
    required: config.apiAuth?.required === true,
    oidcEnabled: config.oidc?.enabled === true,
    tokenConfigured: Boolean(apiAuthToken),
  });

  const webhookSecret = config.webhookSecretEnv
    ? process.env[config.webhookSecretEnv]
    : null;
  checks.push({
    name: "webhook_secret",
    ok: Boolean(webhookSecret),
    requiredForWebhooks: true,
    secretConfigured: Boolean(webhookSecret),
  });

  const preflight = validateRuntimeConfig(config);
  checks.push({
    name: "runtime_preflight",
    ok: preflight.ok,
    mode: preflight.mode,
    errors: preflight.errors,
    warnings: preflight.warnings,
  });

  const requiredChecks = checks.filter(
    (check) => check.name !== "webhook_secret",
  );
  const ok = requiredChecks.every((check) => check.ok);
  const agentIdentityRegistry = await safeAgentIdentityRegistrySummary({
    config,
    steward,
  });

  return {
    ok,
    service: "eliza-merge-steward",
    checkedAt: new Date().toISOString(),
    store: queueStoreBackend(config),
    configuration: {
      deploymentMode: preflight.mode,
      apiAuthRequired: config.apiAuth?.required === true,
      oidcEnabled: config.oidc?.enabled === true,
      feedbackEnabled: config.feedback?.enabled === true,
      enrichmentEnabled: config.enrichment?.enabled === true,
      integrationEnabled: config.integration?.enabled === true,
      integrationDryRun: config.integration?.dryRun !== false,
      requireWorkItemForAgentPrs:
        config.policy?.requireWorkItemForAgentPrs === true,
      requireWorkReservationForAgentPrs:
        config.policy?.requireWorkReservationForAgentPrs === true,
      requireAgentBranchNamespaceForAgentPrs:
        config.policy?.requireAgentBranchNamespaceForAgentPrs === true,
      agentBranchNamespacePrefix:
        config.policy?.agentBranchNamespacePrefix ?? "agent",
      requireVerifiedAgentRunReceiptForAgentPrs:
        config.policy?.requireVerifiedAgentRunReceiptForAgentPrs === true,
      requireAgentIdentityRegistryForAgentPrs:
        config.policy?.requireAgentIdentityRegistryForAgentPrs === true,
      knownAgentIdCount: agentIdentityRegistry.knownAgentIdCount,
      configuredAgentIdCount: agentIdentityRegistry.configuredAgentIdCount,
      persistedActiveAgentIdCount:
        agentIdentityRegistry.persistedActiveAgentIdCount,
      workerEnabled: config.worker?.enabled === true,
      workerLeaseEnabled: config.worker?.leaseEnabled === true,
    },
    checks,
  };
}

function queueStoreBackend(config = {}) {
  if (config.databaseUrl) return "postgres";
  if (config.queueStorePath) return "json";
  return "memory";
}

async function safeAgentIdentityRegistrySummary({ config = {}, steward } = {}) {
  if (typeof steward?.getAgentIdentityRegistrySummary === "function") {
    try {
      return await steward.getAgentIdentityRegistrySummary();
    } catch {
      // error-policy:J4 degrade to the config-derived summary so /ready keeps
      // serving.
      // Keep /ready focused on reporting the failing readiness check instead of
      // turning a registry count failure into an HTTP 500.
    }
  }

  const configuredAgentIdCount = config.policy?.knownAgentIds?.length ?? 0;
  return {
    required: config.policy?.requireAgentIdentityRegistryForAgentPrs === true,
    configuredAgentIdCount,
    persistedActiveAgentIdCount: 0,
    persistedDisabledAgentIdCount: 0,
    knownAgentIdCount: configuredAgentIdCount,
  };
}

function createForgejoApiClient(config) {
  if (!config.forgejoBaseUrl) {
    return undefined;
  }

  return new ForgejoClient({
    baseUrl: config.forgejoBaseUrl,
    token: config.forgejoTokenEnv
      ? process.env[config.forgejoTokenEnv]
      : undefined,
  });
}

function createEnrichmentClient(config) {
  if (!config.enrichment?.enabled || !config.forgejoBaseUrl) {
    return undefined;
  }

  return new ForgejoClient({
    baseUrl: config.forgejoBaseUrl,
    token: config.forgejoTokenEnv
      ? process.env[config.forgejoTokenEnv]
      : undefined,
  });
}

function createFeedbackClient(config) {
  if (!config.feedback?.enabled || !config.forgejoBaseUrl) {
    return undefined;
  }

  const token = config.forgejoTokenEnv
    ? process.env[config.forgejoTokenEnv]
    : undefined;
  if (!token && config.feedback.dryRun === false) {
    return undefined;
  }

  return new ForgejoClient({
    baseUrl: config.forgejoBaseUrl,
    token,
  });
}

function createIntegrationClient(config) {
  if (
    config.integration?.executor !== "local-git" ||
    !config.integration.gitRemoteUrl
  ) {
    return undefined;
  }

  const statusClient = config.forgejoBaseUrl
    ? new ForgejoClient({
        baseUrl: config.forgejoBaseUrl,
        token: config.forgejoTokenEnv
          ? process.env[config.forgejoTokenEnv]
          : undefined,
      })
    : undefined;

  return new LocalGitIntegrationExecutor({
    remoteUrl: config.integration.gitRemoteUrl,
    workDir: config.integration.gitWorkDir,
    gitBinary: config.integration.gitBinary,
    pushBranch: config.integration.pushBranch,
    mergeMethod: config.integration.mergeMethod,
    deleteBranchAfterMerge: config.integration.deleteBranchAfterMerge,
    mergeTitle: config.integration.mergeTitle,
    mergeMessage: config.integration.mergeMessage,
    statusClient,
    checkConfig: config.integration,
  });
}

export function listen({ config = loadConfig(), logger = console } = {}) {
  const preflight = validateRuntimeConfig(config);
  for (const warning of preflight.warnings) {
    logger.warn?.("[MergeStewardServer] runtime preflight warning", warning);
  }
  if (!preflight.ok) {
    logger.error?.("[MergeStewardServer] runtime preflight failed", {
      errors: preflight.errors,
    });
    throw new Error(
      `merge_steward_preflight_failed:${preflight.errors.map((error) => error.code).join(",")}`,
    );
  }

  const steward = createSteward({ config, logger });
  const server = createServer({ config, logger, steward });
  server.listen(config.port, () => {
    logger.info?.("[MergeStewardServer] listening", { port: config.port });
    if (config.worker?.enabled === true) {
      const workerAbort = new AbortController();
      server.on("close", () => workerAbort.abort());
      server.worker = {
        abort: workerAbort,
        promise: runQueueWorker({
          steward,
          config,
          logger,
          signal: workerAbort.signal,
        }),
      };
    }
  });
  return server;
}

async function readJson(request, config) {
  const raw = await readRawBody(request, config);
  const text = raw.toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch (cause) {
    // error-policy:J3 untrusted request body: a parse failure becomes a typed
    // 400 instead of surfacing as an opaque internal 500.
    const error = new Error("invalid_json_body", { cause });
    error.statusCode = 400;
    throw error;
  }
}

async function readRawBody(request, config = {}) {
  const maxBodyBytes = Math.max(1, config.http?.maxBodyBytes ?? 1024 * 1024);
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBodyBytes) {
      const error = new Error("request_body_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export async function authorizeApiRequest(request, config, authVerifier) {
  const authRequired =
    config.apiAuth?.required === true || config.oidc?.enabled === true;
  if (!authRequired) {
    return { ok: true };
  }

  const expectedToken = config.apiAuth.tokenEnv
    ? process.env[config.apiAuth.tokenEnv]
    : undefined;
  const suppliedToken = bearerToken(request.headers.authorization);
  if (
    suppliedToken &&
    expectedToken &&
    constantTimeEqual(suppliedToken, expectedToken)
  ) {
    return { ok: true, identity: { kind: "static-token" } };
  }

  if (suppliedToken && authVerifier) {
    try {
      return {
        ok: true,
        identity: {
          kind: "oidc",
          ...(await authVerifier.verify(suppliedToken)),
        },
      };
    } catch {
      // error-policy:J3 untrusted bearer token: verification failure is an
      // explicit 401
      return unauthorized();
    }
  }

  if (config.apiAuth?.required === true && !expectedToken && !authVerifier) {
    return {
      ok: false,
      statusCode: 503,
      reason: "api_auth_token_unconfigured",
      headers: {},
    };
  }

  return unauthorized();
}

async function authorizeAgentAction(auth, config, steward, requestedAgentId) {
  const agentId = requestedAgentId ? String(requestedAgentId) : "";
  if (!isOidcIdentity(auth?.identity)) {
    if (
      config.policy?.requireAgentIdentityRegistryForAgentPrs === true &&
      agentId &&
      !(await registeredAgentId(config, steward, agentId))
    ) {
      return { ok: false, reason: "agent_identity_unregistered" };
    }
    return { ok: true, agentId: requestedAgentId };
  }

  if (oidcIdentityIsAdmin(auth.identity, config)) {
    if (
      config.policy?.requireAgentIdentityRegistryForAgentPrs === true &&
      agentId &&
      !(await registeredAgentId(config, steward, agentId))
    ) {
      return { ok: false, reason: "agent_identity_unregistered" };
    }
    return { ok: true, agentId: agentId || null };
  }

  const agentIds = agentIdsForIdentity(auth.identity);
  if (!agentId) {
    if (agentIds.length === 1) {
      if (
        config.policy?.requireAgentIdentityRegistryForAgentPrs === true &&
        !(await registeredAgentId(config, steward, agentIds[0]))
      ) {
        return { ok: false, reason: "agent_identity_unregistered" };
      }
      return { ok: true, agentId: agentIds[0] };
    }

    return { ok: false, reason: "agent_identity_required" };
  }

  if (agentIds.includes(agentId)) {
    if (
      config.policy?.requireAgentIdentityRegistryForAgentPrs === true &&
      !(await registeredAgentId(config, steward, agentId))
    ) {
      return { ok: false, reason: "agent_identity_unregistered" };
    }
    return { ok: true, agentId };
  }

  return { ok: false, reason: "agent_identity_mismatch" };
}

function authorizeRegistryOperator(auth, config, requestedActorId) {
  if (
    isOidcIdentity(auth?.identity) &&
    !oidcIdentityIsAdmin(auth.identity, config)
  ) {
    return { ok: false, reason: "agent_identity_registry_admin_required" };
  }

  const actorAuth = authorizeActorAction(auth, config, requestedActorId);
  if (actorAuth.ok) {
    return actorAuth.actorId
      ? actorAuth
      : { ok: true, actorId: auth?.identity?.kind ?? "api-token" };
  }

  if (!isOidcIdentity(auth?.identity) && !requestedActorId) {
    return { ok: true, actorId: auth?.identity?.kind ?? "api-token" };
  }

  return actorAuth;
}

function authorizeActorAction(auth, config, requestedActorId) {
  if (!isOidcIdentity(auth?.identity)) {
    return { ok: true, actorId: requestedActorId };
  }

  const actorAliases = actorAliasesForIdentity(auth.identity);
  const actorId = requestedActorId ? String(requestedActorId) : "";

  if (!actorId) {
    return actorAliases.length > 0
      ? { ok: true, actorId: actorAliases[0] }
      : { ok: false, reason: "actor_identity_required" };
  }

  if (
    actorAliases.includes(actorId) ||
    oidcIdentityIsAdmin(auth.identity, config)
  ) {
    return { ok: true, actorId };
  }

  return { ok: false, reason: "actor_identity_mismatch" };
}

function actorCanDecideApproval(auth, config, actorId, approval) {
  if (
    !isOidcIdentity(auth?.identity) ||
    oidcIdentityIsAdmin(auth.identity, config)
  ) {
    return true;
  }

  const allowedActors = normalizeClaimList(approval?.allowedActors);
  return allowedActors.length === 0 || allowedActors.includes(actorId);
}

function isOidcIdentity(identity) {
  return identity?.kind === "oidc";
}

function oidcIdentityIsAdmin(identity, config) {
  const payload = identity?.payload ?? {};
  const roles = normalizeClaimList(payload.roles ?? payload.role);
  const groups = normalizeClaimList(payload.groups ?? payload.group);
  const adminRoles = config?.oidc?.adminRoles ?? [];
  const adminGroups = config?.oidc?.adminGroups ?? [];

  return intersects(roles, adminRoles) || intersects(groups, adminGroups);
}

function agentIdsForIdentity(identity) {
  const payload = identity?.payload ?? {};
  const explicitAgentIds = unique([
    ...normalizeClaimList(payload.eliza_agent_id),
    ...normalizeClaimList(payload.eliza_agent_ids),
    ...normalizeClaimList(payload.agent_id),
    ...normalizeClaimList(payload.agentId),
    ...normalizeClaimList(payload.agent_ids),
    ...normalizeClaimList(payload.agentIds),
    ...normalizeClaimList(payload.agents),
    ...normalizeClaimList(payload.eliza?.agent_id),
    ...normalizeClaimList(payload.eliza?.agentId),
    ...normalizeClaimList(payload.eliza?.agent_ids),
    ...normalizeClaimList(payload.eliza?.agentIds),
  ]);

  return explicitAgentIds.length > 0
    ? explicitAgentIds
    : unique([identity?.subject]);
}

async function registeredAgentId(config, steward, agentId) {
  const normalizedAgentId = String(agentId ?? "").trim();
  if (!normalizedAgentId) return false;
  const configured = new Set(
    (config.policy?.knownAgentIds ?? [])
      .map((value) => String(value).trim())
      .filter(Boolean),
  );
  if (configured.has(normalizedAgentId)) return true;
  return steward.isRegisteredAgentId(normalizedAgentId);
}

function actorAliasesForIdentity(identity) {
  const payload = identity?.payload ?? {};
  return unique([
    payload.eliza_actor_id,
    payload.elizaActorId,
    payload.preferred_username,
    payload.username,
    payload.login,
    payload.email,
    payload.sub,
    identity?.subject,
  ]);
}

function normalizeClaimList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeClaimList(item));
  }

  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (typeof value === "string") {
    return value
      .split(/[,\s]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [String(value)];
}

function intersects(actual, expected) {
  if (!expected.length) {
    return false;
  }

  const actualSet = new Set(actual);
  return expected.some((item) => actualSet.has(item));
}

function unique(values) {
  return [
    ...new Set(
      values
        .map((value) => (value == null ? "" : String(value)))
        .filter(Boolean),
    ),
  ];
}

function unauthorized() {
  return {
    ok: false,
    statusCode: 401,
    reason: "unauthorized",
    headers: {
      "www-authenticate": "Bearer",
    },
  };
}

function bearerToken(header) {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(.+)$/i.exec(String(value ?? "").trim());
  return match?.[1] ?? null;
}

function constantTimeEqual(a, b) {
  const left = tokenDigest(a);
  const right = tokenDigest(b);
  return timingSafeEqual(left, right);
}

function tokenDigest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function queryBoolean(url, name) {
  const value = url.searchParams.get(name);
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseRunRoute(pathname) {
  const match = /^\/api\/runs\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  return {
    id: decodeURIComponent(match[1]),
    child: match[2] ? decodeURIComponent(match[2]) : null,
  };
}

function parseAgentInboxRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/inbox$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function parseAgentBootstrapRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/bootstrap$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function parseAgentCockpitRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/cockpit$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function parseAgentActionPlanRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/action-plan$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function parseAgentSubmissionGateRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/submission-gate$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function parseAgentWorkPreflightRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/work-preflight$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function parseAgentWorkReservationRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/work-reservation$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function parseAgentClaimNextRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/claim-next$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function parseAgentClaimAssignmentRoute(pathname) {
  const match = /^\/api\/agents\/([^/]+)\/claim-assignment$/.exec(pathname);
  if (!match) return null;
  return {
    agentId: decodeURIComponent(match[1]),
  };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, extraHeaders);
  response.end(payload);
}

async function readOpenApiContractText() {
  openApiContractTextPromise ??= readFile(OPENAPI_CONTRACT_URL, "utf8");

  try {
    return await openApiContractTextPromise;
  } catch (error) {
    // error-policy:J6 drop the memoized promise so a later call can retry, then
    // rethrow
    openApiContractTextPromise = undefined;
    throw error;
  }
}

async function readOpenApiContractVersion() {
  const contract = JSON.parse(await readOpenApiContractText());
  return contract.info?.version ?? "0.1.0";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listen();
}
