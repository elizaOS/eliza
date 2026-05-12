/**
 * POST /api/v1/containers/credentials  (DEPRECATED — 410 Gone)
 *
 * The Hetzner-Docker container backend pulls images directly from
 * GHCR / Docker Hub / any public-or-token-accessible registry. There is
 * no per-tenant ECR repository to vend credentials for.
 *
 * Callers should push the image to a registry and pass the full reference
 * as `image` to POST /api/v1/containers.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", (c) =>
  c.json(
    {
      success: false,
      error:
        "ECR credential vending was removed when the container backend moved off AWS. Push your image to GHCR (or any public registry) and pass `image: 'ghcr.io/owner/repo:tag'` to POST /api/v1/containers.",
      code: "ecr_credentials_removed",
    },
    410,
  ),
);

export default app;
