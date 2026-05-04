/**
 * POST /api/my-agents/characters/avatar
 *
 * Uploads a character avatar image to R2. Returns a public URL for the client to store on the character.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { putPublicObject } from "@/lib/storage/r2-public-object";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function isFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    typeof (value as File).type === "string"
  );
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const authed = await requireUserOrApiKeyWithOrg(c);
    const ct = c.req.header("content-type") ?? "";
    if (!ct.includes("multipart/form-data")) {
      return c.json({ success: false, error: "Expected multipart form data with file field" }, 400);
    }

    const form = await c.req.formData();
    const entry = form.get("file");
    if (!isFile(entry)) {
      return c.json({ success: false, error: "Missing file" }, 400);
    }

    if (entry.size > MAX_BYTES) {
      return c.json({ success: false, error: "File too large (max 5MB)" }, 400);
    }

    const mime = entry.type || "application/octet-stream";
    if (!ALLOWED.has(mime)) {
      return c.json({ success: false, error: "Unsupported image type" }, 400);
    }

    const ext =
      mime === "image/jpeg"
        ? "jpg"
        : mime === "image/png"
          ? "png"
          : mime === "image/webp"
            ? "webp"
            : "gif";

    const key = `avatars/characters/${authed.organization_id}/${authed.id}/${crypto.randomUUID()}.${ext}`;
    const buf = await entry.arrayBuffer();

    const { url } = await putPublicObject(c.env, {
      key,
      body: buf,
      contentType: mime,
      customMetadata: {
        userId: authed.id,
        organizationId: authed.organization_id,
      },
    });

    return c.json({ success: true, url });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.all("*", (c) => c.json({ success: false, error: "Method not allowed" }, 405));

export default app;
