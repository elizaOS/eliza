# Registry PR Checklist

For a third-party package registration:

- [ ] I only added or updated JSON under `entries/third-party/`
- [ ] I did not edit generated outputs (`index.json`, `generated-registry.json`, `registry-summary.json`)
- [ ] The `package` value is the public npm package name
- [ ] The `repository` value is `github:owner/repo` with no `.git` suffix
- [ ] The package does not use the reserved `@elizaos/*` scope
- [ ] The package is third-party/community supported, not first-party supported
- [ ] `npm view <package>` succeeds
- [ ] `git ls-remote https://github.com/<owner>/<repo>.git HEAD` succeeds

Optional context:

- What does the package add?
- Are there setup docs or required environment variables?
