/** Public service identity and plain-text legal documents for app-owned login views. */
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const text = z.string().refine((value) => value.trim().length > 0);
const document = z.strictObject({
  title: text,
  revision: text,
  sections: z
    .array(
      z.strictObject({
        title: text,
        paragraphs: z.array(text).min(1),
      }),
    )
    .min(1),
});
const service = z.strictObject({
  name: text,
  terms: document,
  privacy: document,
});

const app = new Hono<AppEnv>();
app.get("/", (c) => {
  // This deployment-owned value is public. Never read identity or legal text from a caller,
  // an app registration, a session, or a remote URL. A native client renders text, not HTML.
  c.header("Cache-Control", "no-store");
  const split = [
    c.env.CLOUD_PUBLIC_SERVICE_NAME,
    c.env.CLOUD_PUBLIC_SERVICE_TERMS_JSON,
    c.env.CLOUD_PUBLIC_SERVICE_PRIVACY_JSON,
  ];
  let value: unknown;
  try {
    if (split.some((part) => part !== undefined)) {
      // Never combine a partial new deployment with stale legacy legal text.
      if (
        split.some(
          (part) =>
            typeof part !== "string" ||
            !part.trim() ||
            new TextEncoder().encode(part).length > 5120,
        )
      ) {
        throw new Error("Invalid service binding");
      }
      value = {
        name: split[0],
        terms: JSON.parse(split[1]!),
        privacy: JSON.parse(split[2]!),
      };
    } else {
      const raw = c.env.CLOUD_PUBLIC_SERVICE_JSON;
      if (!raw || new TextEncoder().encode(raw).length > 262144) {
        throw new Error("Invalid legacy service binding");
      }
      value = JSON.parse(raw);
    }
  } catch {
    return c.json(
      { success: false, error: "service_metadata_unavailable" },
      503,
    );
  }
  const parsed = service.safeParse(value);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "service_metadata_unavailable" },
      503,
    );
  }
  const result = { success: true, version: 1, service: parsed.data };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 262144) {
    return c.json(
      { success: false, error: "service_metadata_unavailable" },
      503,
    );
  }
  return c.json(result);
});

export default app;
