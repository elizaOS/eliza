# Add a Third-Party Plugin

Third-party packages are registered by pull request. They appear in the public
registry as `origin: "third-party"` and `support: "community"`. Registration
does not make a package first-party supported.

## Before You Submit

Make sure the package is ready for users:

- The npm package is published and public.
- The GitHub repository is public.
- The package name does not use the reserved `@elizaos/*` scope.
- `package.json` has a useful `description`, `keywords`, `repository`, and
  optional `homepage`.
- The package can build from source and its README explains installation and
  configuration.

## Submit With the CLI

From your plugin project, run:

```sh
elizaos plugins submit .
```

The command reads your `package.json`, validates the npm package and GitHub
repository, creates `entries/third-party/<package>.json`, pushes a branch to
your fork of `elizaos-plugins/registry`, and opens a pull request.

Useful options:

```sh
elizaos plugins submit . --dry-run
elizaos plugins submit . --no-pr
elizaos plugins submit . --registry elizaos-plugins/registry
```

Use `--dry-run` before publishing the PR if you want to inspect the generated
metadata.

## Submit Manually

Fork `elizaos-plugins/registry`, then add one file under
`entries/third-party/`:

```json
{
  "package": "@your-scope/plugin-example",
  "repository": "github:your-org/plugin-example",
  "kind": "plugin",
  "description": "Short description shown in the registry.",
  "homepage": "https://github.com/your-org/plugin-example#readme",
  "tags": ["example", "elizaos"]
}
```

`kind` must be one of:

- `plugin`
- `connector`
- `app`

Then run:

```sh
npm run validate
```

Open a pull request with only the metadata file unless maintainers ask for a
generated-output update.

## Review Rules

Maintainers check that:

- The package and repository are public.
- The submitter has a clear connection to the repository.
- The metadata is accurate and schema-valid.
- The package is not impersonating an elizaOS first-party package.
- The package has enough README/configuration detail for users to operate it.

After merge, the published registry page and JSON data update through the
registry publishing workflow. Future npm releases are picked up by the
generator's npm version lookup; open another registry PR only when metadata
such as description, tags, repository, kind, or app launch information changes.
