/**
 * Container request schemas — the source of truth for the `/api/v1/containers`
 * wire contract.
 *
 * Extracted from the route handlers so the contract can be unit-tested in
 * isolation (no Hono/Drizzle imports) and so the `@elizaos/cloud-sdk` types that
 * mirror it can be validated against the *real* schema.
 *
 * IMPORTANT: these are camelCase. zod's `z.object` strips unknown keys, so a
 * snake_case body (`project_name`, `environment_vars`, …) is silently dropped
 * before a handler ever runs — that previously discarded
 * `environmentVars.ELIZA_APP_ID` (per-app monetization attribution) and
 * `projectName` (the sticky deploy key) on every container create. The SDK's
 * `CreateContainerRequest` / `UpdateContainerRequest` must stay in exact
 * agreement with these shapes.
 */
import { z } from "zod";

/** Body for `POST /api/v1/containers`. */
export const CreateContainerSchema = z.object({
  name: z.string().min(1).max(100),
  /** Container image reference, e.g. `ghcr.io/elizaos/my-app:latest`. */
  image: z.string().min(1).max(512),
  /** Stable project key (sticky scheduling/volumes). Defaults to a slug of `name`. */
  projectName: z.string().min(1).max(100).optional(),
  port: z.number().int().positive().max(65535).optional(),
  cpu: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  environmentVars: z.record(z.string(), z.string()).optional(),
  healthCheckPath: z.string().max(256).optional(),
});

/**
 * Body for `PATCH /api/v1/containers/:id` — action-discriminated:
 * restart | setEnv | scale.
 */
export const PatchContainerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("restart") }),
  z.object({
    action: z.literal("setEnv"),
    environmentVars: z.record(z.string(), z.string()),
  }),
  z.object({
    action: z.literal("scale"),
    desiredCount: z.number().int().positive(),
  }),
]);
