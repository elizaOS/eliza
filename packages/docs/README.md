# ElizaOS Docs: Maintenance & Automation

This README provides an overview of how the Eliza OS documentation (the Docusaurus site within this `packages/docs` directory) is maintained, automated, and kept up-to-date. It serves as a technical reference for contributors and anyone interested in our documentation pipeline.

The live documentation can be found at [eliza.how/docs](https://eliza.how/docs).

## Documentation Lifecycle & Automation Overview

Our documentation lifecycle is built on a "docs-as-code" philosophy, heavily reliant on automation to ensure accuracy, consistency, and timeliness. Here's a breakdown of the key stages and technical components involved:

- **Content Origination & Ingestion:**
  - Manual Markdown authoring for core documentation, guides (`./docs/`), and blog posts (`./blog/`).
  - Developer-written JSDoc comments within TypeScript source code (primarily in `../core/src/`).
  - OpenAPI specifications (e.g., `./src/openapi/eliza-v1.yaml`) defining REST APIs.
  - Automated news fetching by the [`./scripts/update-news.sh`](./scripts/update-news.sh) script (orchestrated by the [`.github/workflows/update-news.yml`](../../.github/workflows/update-news.yml) workflow) into the `./news/` directory. This script ensures the last 14 days of news are maintained.
- **Automated Generation & Transformation:**
  - The `docusaurus-plugin-typedoc` (configured in [`./docusaurus.config.ts`](./docusaurus.config.ts)) processes JSDoc comments from source code into browsable API documentation, output to `./api/`.
  - The `docusaurus-plugin-openapi-docs` (configured in [`./docusaurus.config.ts`](./docusaurus.config.ts)) converts OpenAPI specification files into REST API documentation, output to `./docs/rest/`.
  - The `repomix` tool, driven by the [`.github/workflows/llmstxt-generator.yml`](../../.github/workflows/llmstxt-generator.yml) workflow and configured via [`../../scripts/repomix.config.json`](../../scripts/repomix.config.json) & [`../../scripts/repomix-full.config.json`](../../scripts/repomix-full.config.json), generates consolidated AI context files. These are output to `./static/llms.txt` (community-focused) and `./static/llms-full.txt` (technical focus).
  - The `autodoc` package ([`../autodoc/`](../autodoc/README.md)), leveraged by the [`.github/workflows/jsdoc-automation.yml`](../../.github/workflows/jsdoc-automation.yml) workflow, assists in generating JSDoc comment skeletons for source code.
  - AI-driven translation of the root project [README.md](../../README.md) is handled by the [`.github/workflows/generate-readme-translations.yml`](../../.github/workflows/generate-readme-translations.yml) workflow, with outputs stored in `./packages/docs/i18n/readme/` (note: this path might need verification relative to the workflow's execution context).
  - Various custom scripts residing in [`./scripts/`](./scripts/README.md) (e.g., `get-changelog.py`, `update-partner-pages.js`) handle updates for specific documentation sections.
- **CI/CD Validation & Build Pipeline (GitHub Actions):**
  - Workflows such as [`ci.yaml`](../../.github/workflows/ci.yaml) and [`pr.yaml`](../../.github/workflows/pr.yaml) (defined in [`.github/workflows/`](../../.github/workflows/README.md)) trigger on code pushes and pull requests to the repository.
  - These CI pipelines execute essential checks including Markdown linting, broken link detection, and a full Docusaurus site build (`bun run build` within this `packages/docs` directory).
- **Deployment & Delivery:**
  - Upon successful validation and merge to the main branch, the Docusaurus site is automatically built and deployed (typically via `gh-pages` as configured in [`docusaurus.config.ts`](./docusaurus.config.ts)) to [eliza.how/docs](https://eliza.how/docs).
  - All generated artifacts, including API documentation, news articles, and AI context files, are versioned and become part of the deployed documentation site.
- **Iterative Refinement & Monitoring:**
  - Continuous monitoring of GitHub Actions workflow success, documentation build times, and overall site health.
  - Manual review cycles for AI-generated content (such as JSDoc suggestions and language translations) to ensure quality and accuracy.
  - Community feedback via GitHub Issues and Pull Requests on the main repository is crucial for driving improvements to both the documentation content and the automation processes.

## Local Verification & Manual Triggers

### Verifying Documentation Locally

To ensure your documentation changes are correct and render as expected before pushing, you can run the Docusaurus development server locally:

```console
# Navigate to the docs package directory if you are not already there
cd packages/docs

# Install dependencies (if you haven't already or if they changed)
bun install

# Start the Docusaurus development server
bun run start
```

This will typically make the local development site available at `http://localhost:3000` (Docusaurus will confirm the port in the console output).

Alternatively, for a full build similar to the CI process:

```console
# Navigate to the docs package directory
cd packages/docs

# Run the build command
bun run build
```

This will build the static site into the `build/` directory within `packages/docs`.

### Manually Triggering Automated Processes

While most updates are automated, some workflows can be manually triggered if needed:

1.  **GitHub Actions Workflows:** Many of the documentation-related workflows (e.g., `llmstxt-generator.yml`, `update-news.yml`) can be run manually via the "Actions" tab of the [Eliza OS GitHub repository](https://github.com/elizaOS/eliza/actions). Look for the specific workflow and use the "Run workflow" option.
2.  **Local Script Execution:** Some underlying scripts can be run locally:
    - To update news and the Repomix config: `cd ../../scripts && ./update-news.sh` (adjust path if running from a different directory).

This structured, automated lifecycle ensures our documentation remains a dynamic, accurate, and comprehensive resource for the ElizaOS community.
