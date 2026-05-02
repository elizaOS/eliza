/**
 * Cloud API — Cloudflare Workers entrypoint (thin bootstrap).
 *
 * The full Hono stack lives in `./bootstrap-app.ts` and is loaded on first
 * `fetch` / `scheduled` invocation so Worker startup stays under Cloudflare's
 * CPU budget (error 10021).
 *
 *   bun run codegen   # regen the router after adding/removing routes
 *   bun run dev       # wrangler dev
 *   bun run deploy    # wrangler deploy
 */

import "./worker-polyfills";

import type { Hono } from "hono";
import { makeCronHandler } from "@/lib/cron/cloudflare-cron";
import type { AppEnv } from "@/types/cloud-worker-env";

let appPromise: Promise<Hono<AppEnv>> | undefined;

async function getApp(): Promise<Hono<AppEnv>> {
  appPromise ??= import("./bootstrap-app").then((m) => m.createApp());
  return appPromise;
}

function healthResponse(env: AppEnv["Bindings"]): Response {
  return Response.json(
    {
      status: "ok",
      timestamp: Date.now(),
      region: (env as { CF_REGION?: string }).CF_REGION ?? "unknown",
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}

const scheduled = makeCronHandler(async (request, env, ctx) =>
  (await getApp()).fetch(request, env, ctx),
);

export default {
  fetch: async (request: Request, env: AppEnv["Bindings"], ctx: ExecutionContext) => {
    if (new URL(request.url).pathname === "/api/health") {
      return healthResponse(env);
    }

    return (await getApp()).fetch(request, env, ctx);
  },

  scheduled,
};
