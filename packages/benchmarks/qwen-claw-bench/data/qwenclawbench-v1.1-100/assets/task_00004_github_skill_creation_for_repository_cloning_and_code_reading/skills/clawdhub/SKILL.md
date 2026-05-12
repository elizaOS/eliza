# ClawdHub CLI

Use the ClawdHub CLI to search, install, update, and publish agent skills from clawdhub.com.

## Trigger

When you need to fetch new skills, sync installed skills to the latest or a specific version, or publish new/updated skill folders.

## Prerequisites

- `clawdhub` CLI installed via npm: `npm install -g clawdhub`
- Authenticated: `clawdhub auth login`

## Commands

### Search Skills

```bash
clawdhub search "github"
clawdhub search "weather" --category tools
```

### Install a Skill

```bash
clawdhub install <skill-name>
clawdhub install <skill-name>@1.2.0   # specific version
```

### Update Skills

```bash
clawdhub update                       # update all
clawdhub update <skill-name>          # update one
```

### Publish a Skill

```bash
clawdhub publish ./skills/my-skill    # publish from local directory
```

### List Installed Skills

```bash
clawdhub list
clawdhub list --outdated
```

## Notes

- Skills are installed into the configured skills directory.
- Use `clawdhub info <skill-name>` to view metadata and README before installing.
- Publishing requires a verified account on clawdhub.com.
