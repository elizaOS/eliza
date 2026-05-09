import { Hono } from "hono";

import { memoriesRepository } from "@/db/repositories/agents/memories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { isStoredDocumentMemory, resolveDocumentScope, toDocumentRecord } from "../_worker-documents";

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { id } = await nextStyleParams(c, ROUTE_PARAM_SPEC).params;
    if (!id) return c.json({ success: false, error: "Document ID is required" }, 400);

    const scope = await resolveDocumentScope(user, c.req.query("characterId"));
    if (scope instanceof Response) return scope;

    const memory = await memoriesRepository.findById(id);
    if (!isStoredDocumentMemory(memory)) {
      return c.json({ success: false, error: "Document not found" }, 404);
    }
    if (memory.agentId !== scope.agentId || memory.roomId !== scope.roomId) {
      return c.json({ success: false, error: "Document not found" }, 404);
    }

    return c.json({ success: true, document: toDocumentRecord(memory) });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { id } = await nextStyleParams(c, ROUTE_PARAM_SPEC).params;
    if (!id) return c.json({ success: false, error: "Document ID is required" }, 400);

    const scope = await resolveDocumentScope(user, c.req.query("characterId"));
    if (scope instanceof Response) return scope;

    const memory = await memoriesRepository.findById(id);
    if (!isStoredDocumentMemory(memory)) {
      return c.json({ success: false, error: "Document not found" }, 404);
    }
    if (memory.agentId !== scope.agentId || memory.roomId !== scope.roomId) {
      return c.json({ success: false, error: "Document not found" }, 404);
    }

    await memoriesRepository.deleteDocumentFragments(id);
    await memoriesRepository.delete(id);
    return c.json({ success: true, message: "Document deleted successfully" });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
