---
title: "Agent skills"
sidebarTitle: "Skills"
description: "Author and manage file-based Agent Skills with progressive context disclosure."
---

Agent Skills are folders of instructions and optional supporting resources.
`@elizaos/plugin-agent-skills` discovers them, exposes compact metadata to the
agent, and loads full instructions only when a skill is selected.

Use a skill for a procedure or knowledge bundle. Use a plugin when you need
executable TypeScript, a long-lived service, a model handler, or an HTTP route.

## Create a skill

Every skill directory contains `SKILL.md`:

```text
skills/
└── release-check/
    ├── SKILL.md
    ├── scripts/
    ├── references/
    └── assets/
```

Only `SKILL.md` is required. Its frontmatter requires `name` and
`description`:

```markdown
---
name: release-check
description: Verify an elizaOS package before release. Use for release readiness and publishing checks.
---

## Instructions

1. Read the package's CLAUDE.md.
2. Run its build, typecheck, lint, and tests.
3. Inspect the built package and report any failure.
```

Names are lowercase letters, digits, and hyphens. Write the description so the
agent can decide when the skill applies without loading the full body.

Optional frontmatter follows the
[Agent Skills specification](https://agentskills.io/specification), including
`license`, `compatibility`, `metadata`, and `allowed-tools`.

## Supporting resources

- Put executable helpers in `scripts/`.
- Put detailed material loaded only when needed in `references/`.
- Put templates and other reusable inputs in `assets/`.
- Keep paths relative to the skill directory so the bundle remains portable.

The body should describe decisions, ordering constraints, validation, and
failure handling. Do not paste entire API references into the skill.

## Enable the plugin

The agent-skills plugin activates when `features.agentSkills` is enabled in the
agent configuration. Its default filesystem source is `./skills`; `SKILLS_DIR`
can select another directory.

Useful optional settings include:

| Setting | Purpose |
| --- | --- |
| `SKILLS_AUTO_LOAD` | Load installed skills during startup |
| `SKILLS_REGISTRY` | Select the remote registry base URL |
| `SKILLS_ALLOWLIST` | Allow only the listed skill slugs |
| `SKILLS_DENYLIST` | Block listed skill slugs |
| `WORKSPACE_SKILLS_DIR` | Add workspace-scoped skills |
| `PLUGIN_SKILLS_DIRS` | Add plugin-contributed skill directories |

## Invocation and management

`USE_SKILL` is the stable action for invoking an enabled skill. The `SKILL`
action manages search, details, catalog sync, toggling, installation, and
uninstallation. The runtime providers expose a compact enabled-skill list and
load matched instructions progressively.

Installed skills can contain executable scripts. Review their contents and
source before enabling them, restrict the allowed set where appropriate, and
grant only the tools they need.

The current parser, scaffold, settings, actions, and source precedence are in
[`plugins/plugin-agent-skills`](https://github.com/elizaOS/eliza/tree/develop/plugins/plugin-agent-skills).
