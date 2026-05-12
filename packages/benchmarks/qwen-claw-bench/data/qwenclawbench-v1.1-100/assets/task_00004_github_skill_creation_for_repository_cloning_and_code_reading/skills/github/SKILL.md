# GitHub CLI Skill

Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- A valid GitHub token or interactive login

## Usage

### Issues

```bash
gh issue list --repo <owner/repo>
gh issue create --title "Bug" --body "Description"
gh issue view <number>
```

### Pull Requests

```bash
gh pr list --repo <owner/repo>
gh pr create --title "Feature" --body "Description"
gh pr merge <number>
```

### CI / Actions

```bash
gh run list --repo <owner/repo>
gh run view <run-id>
gh run watch <run-id>
```

### API Queries

```bash
gh api repos/<owner>/<repo>/contents/<path>
gh api graphql -f query='{ viewer { login } }'
```

## Notes

- Always check `gh auth status` before running commands.
- Use `--json` flag for machine-readable output.
- Rate limits apply to API calls (~5000/hour for authenticated users).
