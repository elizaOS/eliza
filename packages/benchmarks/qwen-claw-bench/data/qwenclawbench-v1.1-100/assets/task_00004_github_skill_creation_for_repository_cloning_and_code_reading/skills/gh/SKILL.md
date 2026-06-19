# gh — GitHub CLI Core Operations

Use the GitHub CLI (`gh`) to perform core GitHub operations: auth status, repo create/clone/fork, issues, pull requests, releases, and basic repo management.

## Trigger

Requests to use gh, manage GitHub repos, PRs, or issues from the CLI.

## Prerequisites

- `gh` CLI installed (`gh --version`)
- Authenticated via `gh auth login` or `GITHUB_TOKEN` env var

## Commands

### Authentication

```bash
gh auth status
gh auth login --web
```

### Repository Management

```bash
gh repo create <name> --public
gh repo clone <owner/repo>
gh repo fork <owner/repo>
gh repo view <owner/repo>
```

### Issues

```bash
gh issue list
gh issue create --title "Title" --body "Body"
gh issue close <number>
```

### Pull Requests

```bash
gh pr list
gh pr create --fill
gh pr checkout <number>
gh pr merge <number> --merge
```

### Releases

```bash
gh release list
gh release create v1.0.0 --title "Release 1.0"
gh release download v1.0.0
```

## Notes

- Prefer `gh repo clone` over `git clone` for GitHub repos (handles auth automatically).
- Use `--json` for structured output: `gh issue list --json number,title,state`
