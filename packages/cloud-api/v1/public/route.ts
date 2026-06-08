/**
 * GET /api/v1/public/*
 *
 * Local development utility route to serve public R2 objects (like avatars)
 * from the local BLOB storage bucket mock.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/*", async (c) => {
  try {
    const path = c.req.path;
    const prefix = "/api/v1/public/";
    const key = path.startsWith(prefix) ? path.slice(prefix.length) : path;

    if (!c.env.BLOB) {
      return c.json({ success: false, error: "BLOB binding not configured" }, 500);
    }

    const object = await (c.env.BLOB as any).get(key);
    if (!object) {
      return c.notFound();
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    return c.body(object.body, 200, Object.fromEntries(headers.entries()));
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
