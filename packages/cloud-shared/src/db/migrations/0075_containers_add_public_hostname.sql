-- Add per-container public hostname for ingress reverse-proxy mapping.
--
-- The hostname is the leftmost label under CONTAINERS_PUBLIC_BASE_DOMAIN.
-- Operators consume `GET /api/v1/admin/containers/ingress-map` to wire
-- their reverse proxy (Caddy / Traefik / Cloudflare Tunnel) to the
-- corresponding `host:port` upstreams.

ALTER TABLE "containers"
  ADD COLUMN IF NOT EXISTS "public_hostname" text;

CREATE INDEX IF NOT EXISTS "containers_public_hostname_idx"
  ON "containers" ("public_hostname");
