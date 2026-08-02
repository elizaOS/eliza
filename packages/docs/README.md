# elizaOS Documentation

Source for the public [elizaOS](https://github.com/elizaOS/eliza) documentation site, built with [Mintlify](https://mintlify.com). Internal plans, audits, and compliance artifacts live in the repository-root `docs/` tree instead.

## Local Development

Preview from this directory with the current Mintlify CLI:

```bash
bun run --cwd packages/docs predev
cd packages/docs && bunx mintlify@latest dev
```

The preview starts at `http://localhost:3000`. Brand assets (logos, favicons, OG embeds, banners) are automatically synced from `packages/shared` before dev and build.

## Project Structure

```
packages/docs/
├── docs.json          # Mintlify site config: navigation, colors, fonts, logo
├── index.mdx          # Home page
├── quickstart.mdx     # Quickstart
├── tracks/            # Product content (OS, Runtime, App, Cloud, Eliza-1)
├── apps/              # App layer pages (desktop, mobile, dashboard, ui-library)
├── runtime/           # Runtime internals reference
├── plugins/           # Plugin reference pages
├── cli/               # CLI reference
├── cloud/             # Eliza Cloud reference
├── development/       # Developer workflows shared across packages
├── user/              # End-user guides
├── test/              # Test suite (nav integrity, broken links)
└── public/            # Static assets (auto-generated — do not hand-edit)
```

## Adding or Editing Pages

1. Create a `.mdx` or `.md` file in the appropriate directory.
2. Add its path (no extension) to the correct group in `docs.json` under `navigation.tabs`.
3. Run tests to catch missing pages and broken links:
   ```bash
   bun run --cwd packages/docs test
   ```
4. From the repository root, run `bun run --cwd packages/docs predev`, then start `bunx mintlify@latest dev` inside `packages/docs`.

## Tests

`test/docs.test.js` uses Node's built-in test runner. It validates:

- `docs.json` is valid and has required Mintlify fields.
- Navigation tabs and groups contain no duplicate labels or pages.
- Every page referenced in navigation exists on disk.
- No unlisted content page is hidden outside navigation.
- All markdown files are non-empty and have structurally valid frontmatter.
- Internal links, local assets, repository paths, and GitHub source links resolve.
- Documented Bun scripts and Cloud API paths exist in their source packages.

## Publishing

Publishing is handled by the configured Mintlify GitHub integration. Its deployment branch and site settings are managed outside this package.

If a page shows as 404 after deploy, confirm the file path appears in `docs.json` navigation and that the Mintlify CLI shows no errors locally.

## Learn More

- [elizaOS GitHub Repository](https://github.com/elizaOS/eliza)
- [Mintlify Documentation](https://mintlify.com/docs)
- [MDX Documentation](https://mdxjs.com/)
