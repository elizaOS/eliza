# Plugin and project build workflow

Use this reference when implementing an Eliza host-app feature, shipped plugin,
local plugin, published project, or worker-built project.

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

## Project build shape

For new user-created projects:

1. Register or resolve the durable local project before publishing.
2. Prefer Eliza Cloud for auth, users, credits, analytics, billing, domains, and
   hosting when Cloud is connected and publishing is requested.
3. Bind exactly one Cloud app record through `ProjectRecord.cloudAppId`; do not
   introduce another identity map.
4. Publish the managed frontend first. Deploy a container only when server code
   is needed and the organization is allowlisted.
5. Keep API keys and owner credentials server-side only.
6. Use app auth and the stable app-scoped Cloud endpoints for chat/inference.
7. Enable monetization when the published project calls paid inference for users.
8. Use app charge requests or x402 payment requests for exact prices or
   arbitrary payment approvals.
9. Use Cloud promotion/image/video/music/TTS APIs for launch assets; use the
   parent runtime only for media capabilities not exposed by the Cloud API.

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

For published projects, verify the project binding, managed frontend or
container liveness, app auth, proxy behavior, monetization settings, and public
URL/origins. For orchestrated workers, verify `SKILLS.md` generation and a
`USE_SKILL parent-agent` callback path.
