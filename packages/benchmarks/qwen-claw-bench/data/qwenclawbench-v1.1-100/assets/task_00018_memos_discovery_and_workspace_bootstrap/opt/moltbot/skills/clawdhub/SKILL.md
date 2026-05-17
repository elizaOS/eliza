# ClawdHub CLI

Use the ClawdHub CLI to search, install, update, and publish agent skills from clawhub.com.

## When to Use

- Finding new skills to install
- Installing a skill by name or keyword
- Updating installed skills to the latest version
- Publishing new or updated skill folders

## Prerequisites

The `clawhub` CLI is installed globally or as a project dependency:

```bash
npx clawhub@latest --version
```

## Commands

### Search for skills

```bash
npx clawhub@latest search <query>
```

Search by name, description, or keyword. Returns matching skills with version, author, and download count.

### Install a skill

```bash
npx clawhub@latest install <skill-name> [--path /target/skills/dir]
```

By default installs to the current working directory's `skills/` folder. Use `--path` to specify an alternate location.

Options:
- `--version <semver>` — Install a specific version
- `--path <dir>` — Target installation directory (default: `./skills/`)
- `--force` — Overwrite existing skill folder

### List installed skills

```bash
npx clawhub@latest list [--path /skills/dir]
```

### Update a skill

```bash
npx clawhub@latest update <skill-name> [--path /skills/dir]
```

### Publish a skill

```bash
npx clawhub@latest publish <skill-folder> [--public]
```

Requires authentication via `npx clawhub@latest login`.

## Examples

```bash
# Search for memory-related skills
npx clawhub@latest search memory

# Install a skill to the moltbot skills directory
npx clawhub@latest install sonoscli --path /opt/moltbot/skills/

# Update all skills
npx clawhub@latest update --all --path /opt/moltbot/skills/
```

## Notes

- Skills are versioned like npm packages (semver)
- Each skill folder must contain a `SKILL.md` at its root
- The CLI validates skill structure before install
- Registry: https://clawhub.ai
