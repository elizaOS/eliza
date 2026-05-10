# Plugin And App Build Workflow

Use this reference when implementing an Eliza app feature, shipped plugin, local plugin, Cloud app, or worker-built app.

## Decide The Ownership Boundary

Choose the smallest correct ownership target:

- `packages/app-core/` for CLI, local API, onboarding, config, runtime startup, and app shell behavior
- `packages/agent/` for Eliza app runtime glue, providers, default skill roots, and app-level plugin wiring
- `apps/app/` for dashboard and Electrobun UI
- `packages/cli/` for user-facing plugin/app commands
- `packages/skills/skills/` for bundled default skills
- `plugins/plugin-*` or `packages/plugin-*` for runtime plugins
- `cloud/` for Eliza Cloud backend, SDK, billing, containers, apps, domains, and monetization

Do not create a second mechanism when an existing runtime, plugin, skill, Cloud, or LifeOps primitive already owns the behavior.

## Plugin Shape

Follow elizaOS plugin conventions:

- actions perform operations and side effects
- providers contribute state/context
- services own long-lived clients and background connections
- routes expose plugin-owned HTTP APIs
- models register inference handlers
- evaluators run after messages/actions

Use the `elizaos` skill for upstream details. Keep app-specific product glue in app packages and upstream abstractions in elizaOS packages.

## App Build Shape

For new app experiences:

1. Prefer Eliza Cloud for auth, app users, credits, analytics, billing, domains, and deployment when Cloud is enabled or requested.
2. Use an app record and `appId` for browser-facing identity.
3. Keep API keys and owner credentials server-side only.
4. Use app auth for users and app-scoped Cloud endpoints for chat/inference.
5. Enable monetization when the app calls paid inference on behalf of users.
6. Use app charge requests or x402 payment requests when the product needs exact prices or arbitrary payment approvals.
7. Use Cloud promotion/image/video/music/TTS APIs for launch assets; use the parent runtime only for extra media capabilities that are not exposed by the Cloud API.
8. Deploy a container only when server code is needed; static hosting is acceptable for legacy/local static apps.

Use `eliza-cloud`, `build-monetized-app`, and `eliza-cloud-buy-domain` for Cloud-specific implementation details.

## Skill Defaults

Default skills should be bundled under:

```text
packages/skills/skills/<slug>/SKILL.md
```

Runtime startup seeds them into the managed skills store without overwriting existing editable copies. Applications and workspaces can override defaults by providing a skill with the same slug in a higher-priority skill root.

When adding a default skill:

1. Add `SKILL.md` with concise frontmatter and task guidance.
2. Put long details in `references/*.md`.
3. Keep descriptions broad enough to trigger correctly but specific enough to avoid unrelated use.
4. Run the package skill tests when possible.

## Verification

Use the narrowest meaningful verification first:

```bash
bun test <package-or-test>
bun run --cwd <package> test
bun run --cwd <package> typecheck
```

Then run broader repo checks when the change crosses package boundaries:

```bash
bun run verify
bun run test
```

For Cloud app builds, verify app auth, proxy behavior, health checks, monetization settings, and container URL/origins. For orchestrated workers, verify `SKILLS.md` generation and a `USE_SKILL parent-agent` callback path.
