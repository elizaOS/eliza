# Skill Creator

Create or update AgentSkills. Use when designing, structuring, or packaging skills with scripts, references, and assets.

## Skill Structure

```
skills/<skill-name>/
├── SKILL.md          # Required: main skill definition
├── scripts/          # Optional: automation scripts
│   └── setup.sh
├── references/       # Optional: reference docs
│   └── api-docs.md
└── assets/           # Optional: images, configs
    └── config.example.json
```

## SKILL.md Template

```markdown
# Skill Name

Brief description of what the skill does.

## Trigger

When this skill should be activated.

## Prerequisites

- Required tools, CLIs, API keys, etc.

## Usage

Step-by-step instructions or command examples.

## Scripts

Reference any helper scripts in `scripts/`.

## Notes

Edge cases, caveats, tips.
```

## Rules

- `SKILL.md` is the single entry point — the agent reads this first.
- Keep it concise. Link to `references/` for long docs.
- Scripts in `scripts/` should be executable and documented.
- Use `assets/` for example configs, templates, etc.
- Skill name = directory name (lowercase, hyphens).
