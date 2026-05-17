# gh repo Commands Reference

## gh repo clone

Clone a GitHub repository locally.

```bash
gh repo clone <owner/repo> [<directory>]
gh repo clone <owner/repo> -- --depth 1    # shallow clone
```

## gh repo view

View repository details.

```bash
gh repo view <owner/repo>
gh repo view <owner/repo> --json name,description,url
gh repo view <owner/repo> --web           # open in browser
```

## gh repo create

Create a new repository.

```bash
gh repo create my-project --public --clone
gh repo create my-project --private --add-readme
```

## gh repo fork

Fork a repository.

```bash
gh repo fork <owner/repo>
gh repo fork <owner/repo> --clone
```

## gh repo list

List repositories.

```bash
gh repo list <owner>
gh repo list <owner> --json name,url --limit 20
```

## Tips

- `gh repo clone` auto-configures remotes and auth for you.
- Use `-- --depth 1` for large repos you only need to read (faster).
- `gh repo view --json` is great for scripting.
