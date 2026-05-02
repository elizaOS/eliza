/**
 * Legacy alias for `/api/v1/voice/clone`. Kept so older clients that hit the
 * provider-specific `/api/elevenlabs/voices/clone` path continue to work.
 * Re-exports the canonical Hono app so auth, rate limiting, and billing all
 * flow through one implementation.
 */

export type { Hono } from "hono";
export { default } from "@/api/v1/voice/clone/route";
