/**
 * Vast.ai training-job HTTP routes.
 *
 * Mirrors the node:http handler-delegate shape used by `training-routes.ts`:
 * a single `handleVastTrainingRoutes(ctx)` that returns `true` once it has
 * matched + responded to a request, `false` otherwise. Wired into the
 * existing plugin route registry from `setup-routes.ts`.
 *
 * Auth: enforced upstream by the runtime plugin route dispatcher, which
 * rejects non-`public` routes when the caller is not authorized. We do not
 * call `ensureRouteAuthorized` here.
 *
 * Route surface (all under `/api/training/vast/...`):
 *   POST   /jobs                              → create job (201 + record)
 *   GET    /jobs                              → list jobs
 *   GET    /jobs/:id                          → fetch one job
 *   POST   /jobs/:id/cancel                   → cancel a non-terminal job
 *   POST   /jobs/:id/eval                     → run eval_checkpoint.py
 *   GET    /jobs/:id/logs?tail=200            → tail per-job log
 *   GET    /models?refresh=1                  → registry listing
 *   GET    /models/:short_name/checkpoints    → checkpoints for a registry key
 *   GET    /inference/endpoints               → list inference endpoints
 *   POST   /inference/endpoints               → register an inference endpoint
 *   DELETE /inference/endpoints/:id           → delete an inference endpoint
 *   GET    /inference/stats?label=&last_minutes=30
 */

import type { RouteHelpers, RouteRequestContext } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  type CreateJobInput,
  type EvalCheckpointInput,
  VastServiceError,
  type VastTrainingService,
} from "../services/training-vast-service.js";

export type VastRouteHelpers = RouteHelpers;

export interface VastRouteContext extends RouteRequestContext {
  service: VastTrainingService;
}

const PREFIX = "/api/training/vast";

export async function handleVastTrainingRoutes(
  ctx: VastRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, service, json, error, readJsonBody } =
    ctx;
  if (!pathname.startsWith(PREFIX)) return false;

  const sub = pathname.slice(PREFIX.length); // "" or "/foo"

  try {
    // ── Models / registry ──────────────────────────────────────────────
    if (method === "GET" && sub === "/models") {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const refresh = url.searchParams.get("refresh") === "1";
      const out = await service.listRegistry(refresh);
      json(res, out);
      return true;
    }

    const checkpointsMatch = /^\/models\/([^/]+)\/checkpoints$/.exec(sub);
    if (method === "GET" && checkpointsMatch) {
      const shortName = decodeURIComponent(checkpointsMatch[1]);
      const checkpoints =
        await service.listCheckpointsForRegistryKey(shortName);
      json(res, { registry_key: shortName, checkpoints });
      return true;
    }

    // ── Jobs ───────────────────────────────────────────────────────────
    if (method === "POST" && sub === "/jobs") {
      const body = await readJsonBody<Record<string, unknown>>(req, res);
      if (!body) return true;
      const parsed = parseCreateJobInput(body);
      if ("error" in parsed) {
        error(res, parsed.error, 400);
        return true;
      }
      const record = await service.createJob(parsed.input);
      json(
        res,
        {
          job_id: record.job_id,
          run_name: record.run_name,
          status: record.status,
          job: record,
        },
        201,
      );
      return true;
    }

    if (method === "GET" && sub === "/jobs") {
      const jobs = await service.listJobs();
      json(res, { jobs });
      return true;
    }

    const jobMatch = /^\/jobs\/([^/]+)$/.exec(sub);
    if (method === "GET" && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      const job = await service.getJob(jobId);
      if (!job) {
        error(res, "Job not found", 404);
        return true;
      }
      json(res, { job });
      return true;
    }

    const cancelMatch = /^\/jobs\/([^/]+)\/cancel$/.exec(sub);
    if (method === "POST" && cancelMatch) {
      const jobId = decodeURIComponent(cancelMatch[1]);
      const job = await service.cancelJob(jobId);
      json(res, { job });
      return true;
    }

    const evalMatch = /^\/jobs\/([^/]+)\/eval$/.exec(sub);
    if (method === "POST" && evalMatch) {
      const jobId = decodeURIComponent(evalMatch[1]);
      let body: Record<string, unknown> = {};
      const contentLength = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(contentLength) && contentLength > 0) {
        const parsedBody = await readJsonBody<Record<string, unknown>>(
          req,
          res,
        );
        if (!parsedBody) return true;
        body = parsedBody;
      }
      const parsed = parseEvalInput(body);
      if ("error" in parsed) {
        error(res, parsed.error, 400);
        return true;
      }
      const result = await service.runEval(jobId, parsed.input);
      json(res, result);
      return true;
    }

    const logsMatch = /^\/jobs\/([^/]+)\/logs$/.exec(sub);
    if (method === "GET" && logsMatch) {
      const jobId = decodeURIComponent(logsMatch[1]);
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const tail = parsePositiveIntParam(url.searchParams.get("tail"), 200);
      if (tail === null) {
        error(res, "tail must be a positive integer ≤ 5000", 400);
        return true;
      }
      const lines = await service.readJobLog(jobId, tail);
      json(res, { job_id: jobId, tail, lines });
      return true;
    }

    // ── Inference endpoints ────────────────────────────────────────────
    if (method === "GET" && sub === "/inference/endpoints") {
      const endpoints = await service.listInferenceEndpoints();
      json(res, { endpoints });
      return true;
    }

    if (method === "POST" && sub === "/inference/endpoints") {
      const body = await readJsonBody<Record<string, unknown>>(req, res);
      if (!body) return true;
      const parsed = parseEndpointInput(body);
      if ("error" in parsed) {
        error(res, parsed.error, 400);
        return true;
      }
      const record = await service.createInferenceEndpoint(parsed.input);
      json(res, { endpoint: record }, 201);
      return true;
    }

    const epMatch = /^\/inference\/endpoints\/([^/]+)$/.exec(sub);
    if (method === "DELETE" && epMatch) {
      const id = decodeURIComponent(epMatch[1]);
      const ok = await service.deleteInferenceEndpoint(id);
      if (!ok) {
        error(res, "Inference endpoint not found", 404);
        return true;
      }
      json(res, { ok: true, id });
      return true;
    }

    if (method === "GET" && sub === "/inference/stats") {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const labelParam = url.searchParams.get("label");
      const label = labelParam?.trim() ? labelParam.trim() : null;
      const lastMinutes = parsePositiveIntParam(
        url.searchParams.get("last_minutes"),
        30,
      );
      if (lastMinutes === null) {
        error(res, "last_minutes must be a positive integer ≤ 1440", 400);
        return true;
      }
      const stats = await service.getInferenceStats(label, lastMinutes);
      json(res, stats);
      return true;
    }

    // No vast subroute matched — fall through so other handlers can try.
    return false;
  } catch (err) {
    if (err instanceof VastServiceError) {
      error(res, err.message, err.status);
      return true;
    }
    logger.error(
      `[training-vast-routes] ${method} ${pathname} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    error(res, "Internal vast training route error", 500);
    return true;
  }
}

function parseCreateJobInput(
  body: Record<string, unknown>,
): { input: CreateJobInput } | { error: string } {
  const rk = body.registry_key;
  if (typeof rk !== "string" || !rk.trim()) {
    return { error: "registry_key is required" };
  }
  const epochsRaw = body.epochs;
  if (
    typeof epochsRaw !== "number" ||
    !Number.isInteger(epochsRaw) ||
    epochsRaw < 1
  ) {
    return { error: "epochs must be a positive integer" };
  }
  let runName: string | undefined;
  if (body.run_name !== undefined) {
    if (typeof body.run_name !== "string" || !body.run_name.trim()) {
      return { error: "run_name must be a non-empty string when provided" };
    }
    runName = body.run_name.trim();
  }
  return {
    input: { registry_key: rk.trim(), epochs: epochsRaw, run_name: runName },
  };
}

function parseEvalInput(
  body: Record<string, unknown>,
): { input: Partial<EvalCheckpointInput> } | { error: string } {
  const out: Partial<EvalCheckpointInput> = {};
  if (body.checkpoint_dir !== undefined) {
    if (
      typeof body.checkpoint_dir !== "string" ||
      !body.checkpoint_dir.trim()
    ) {
      return { error: "checkpoint_dir must be a non-empty string" };
    }
    out.checkpoint_dir = body.checkpoint_dir.trim();
  }
  if (body.val_jsonl !== undefined) {
    if (typeof body.val_jsonl !== "string" || !body.val_jsonl.trim()) {
      return { error: "val_jsonl must be a non-empty string" };
    }
    out.val_jsonl = body.val_jsonl.trim();
  }
  if (body.max_examples !== undefined) {
    if (
      typeof body.max_examples !== "number" ||
      !Number.isInteger(body.max_examples) ||
      body.max_examples < 1
    ) {
      return { error: "max_examples must be a positive integer" };
    }
    out.max_examples = body.max_examples;
  }
  return { input: out };
}

function parseEndpointInput(
  body: Record<string, unknown>,
):
  | { input: { label: string; base_url: string; registry_key: string } }
  | { error: string } {
  const label = body.label;
  const baseUrl = body.base_url;
  const registryKey = body.registry_key;
  if (typeof label !== "string" || !label.trim()) {
    return { error: "label is required" };
  }
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return { error: "base_url is required" };
  }
  if (typeof registryKey !== "string" || !registryKey.trim()) {
    return { error: "registry_key is required" };
  }
  return {
    input: {
      label: label.trim(),
      base_url: baseUrl.trim(),
      registry_key: registryKey.trim(),
    },
  };
}

function parsePositiveIntParam(
  raw: string | null,
  defaultValue: number,
): number | null {
  if (raw === null || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5000) return null;
  return n;
}
