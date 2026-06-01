# elizaOS Documentation

Source for the [elizaOS](https://github.com/elizaOS/eliza) documentation site, built with [Mintlify](https://mintlify.com). Covers the OS, runtime, app layer, Eliza Cloud, Chip, and Robot tracks.

## Local Development

Install the Mintlify CLI, then preview from this directory:

```bash
bun install -g mint
cd packages/docs
mint dev
```

The preview starts at `http://localhost:3000`. Brand assets (logos, favicons, OG embeds, banners) are automatically synced from `packages/shared` before dev and build.

## Project Structure

```
packages/docs/
├── docs.json          # Mintlify site config: navigation, colors, fonts, logo
├── index.mdx          # Home page
├── quickstart.mdx     # Quickstart
├── tracks/            # Dimension-specific content (OS, Runtime, App, Cloud, Chip, Training)
├── runtime/           # Runtime internals reference
├── agents/            # Agent internals reference
├── plugins/           # Plugin reference pages
├── cli/               # CLI reference
├── connectors/        # Connector pages (Discord, Telegram, iMessage, etc.)
├── cloud/             # Eliza Cloud reference
├── guides/            # How-to guides and tutorials
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
4. Preview with `mint dev`.

## Tests

`test/docs.test.js` uses Node's built-in test runner. It validates:

- `docs.json` is valid and has required Mintlify fields.
- Navigation tabs and groups contain no duplicate labels or pages.
- Every page referenced in navigation exists on disk.
- All markdown files are non-empty.
- All internal links in markdown and MDX files resolve to real files.

## Publishing

Changes merged to the main branch are automatically deployed by the Mintlify GitHub App. The app must be installed on the repository and pointed at the default branch.

If a page shows as 404 after deploy, confirm the file path appears in `docs.json` navigation and that the Mintlify CLI shows no errors locally.

## Learn More

- [elizaOS GitHub Repository](https://github.com/elizaOS/eliza)
- [Mintlify Documentation](https://mintlify.com/docs)
- [MDX Documentation](https://mdxjs.com/)
