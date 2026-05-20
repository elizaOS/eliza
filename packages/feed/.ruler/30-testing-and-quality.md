# Testing & Quality

## Testing philosophy

- Prefer **integration tests** for API/DB/infra flows (tests live under `packages/testing`).
- Use unit tests for small pure logic where they add confidence without heavy mocking.
- Keep tests deterministic; use fakes/stubs where appropriate, but avoid “synthetic success” that doesn’t match real flows.
- For authenticated E2E, use **Synpress** (Metamask login) when relevant.

## When running commands in chat

- Don’t pipe commands (no `| head`, `| tail`, etc.) so outputs stay debuggable.

## Environment

- Root `.env` is the source of truth (see `.env.example`).
- Any new/changed env var must be reflected in `.env.example` (with required/optional + default notes).
- `scripts/pre-dev/pre-dev-local.ts` generates/updates localnet defaults.
