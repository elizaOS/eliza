# Skill Creator

Create or update AgentSkills. Use when designing, structuring, or packaging skills with scripts, references, and assets.

## Skill Structure

```
skill-name/
├── SKILL.md          # Required: skill definition
├── scripts/          # Optional: executable scripts
├── references/       # Optional: reference docs
└── assets/           # Optional: images, templates
```

## SKILL.md Template

```markdown
# Skill Name

Description of what this skill does.

## When to Use
- Trigger conditions

## Instructions
1. Step-by-step guide

## References
- Link to docs
```

## Publishing

```bash
npx clawhub@latest publish ./my-skill --public
```
