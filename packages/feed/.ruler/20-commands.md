# Commands (Bun)

## Install / Dev

- Install: `bun install`
- Full dev: `bun run dev`
- Web only: `bun run dev:web` or `bun run dev:next-only`

## Checks

- Types: `bun run typecheck`
- Lint: `bun run lint`
- Format: `bun run check` (Biome write)
- Build: `bun run build`

## Tests

- Unit: `bun run test:unit`
- Integration: `bun run test:integration`
- E2E: `bun run test:e2e`

## DB (Drizzle)

- Generate: `bun run db:generate`
- Migrate: `bun run db:migrate`
- Push (dev only): `bun run db:push`
- Pull: `bun run db:pull`
- Studio: `bun run db:studio`
- Seed: `bun run db:seed` / `bun run db:seed:test all`

## Docs vendors

- Generate: `bun run docs:generate` (writes to `docs/vendors/*`)
