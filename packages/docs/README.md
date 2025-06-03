# ElizaOS Docs: Maintenance & Automation

This README provides an overview of how the Eliza OS documentation (the Docusaurus site within this `packages/docs` directory) is maintained, automated, and kept up-to-date. It serves as a technical reference for contributors and anyone interested in our documentation pipeline.

The live documentation can be found at [eliza.how/docs](https://eliza.how/docs).

## Documentation Lifecycle & Automation Overview

Our documentation lifecycle is built on a "docs-as-code" philosophy, heavily reliant on automation to ensure accuracy, consistency, and timeliness. Here's a breakdown of the key stages and technical components involved:

- **Docusaurus Source Structure (`./src/`):** The [`./src/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/) directory is the heart of the Docusaurus application. It contains:
  - [`pages/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/pages/): Custom standalone pages (e.g., custom landing pages).
  - [`data/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/data/): Data files, like [`partners.tsx`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/src/data/partners.tsx), used to populate components or pages.
  - [`components/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/components/): Reusable React components specific to the documentation site.
  - [`css/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/css/): Custom CSS stylesheets for theming and styling.
  - [`theme/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/theme/): Docusaurus theme customizations, allowing for overriding or "swizzling" default theme components.
  - [`openapi/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/openapi/): Stores OpenAPI specification files (e.g., [`eliza-v1.yaml`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/src/openapi/eliza-v1.yaml)) used to generate REST API documentation.
- **Content Origination & Ingestion:**
  - Manually authored Markdown for various documentation sections:
    - Core Documentation: Conceptual explanations, guides, and tutorials for ElizaOS, primarily located in [`./docs/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/docs/) and accessible at [eliza.how/docs](https://eliza.how/docs).
    - Packages: Documentation for individual adapters, clients, and plugins, showcased at [eliza.how/packages](https://eliza.how/packages). This showcase is dynamically generated and maintained as follows:
      - The primary source of truth for available plugins is the external [ElizaOS Plugins Registry](https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json).
      - The [`./scripts/update-registry.js`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/scripts/update-registry.js) script fetches this registry data.
      - This script also reads from [`./src/data/plugin-descriptions.json`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/src/data/plugin-descriptions.json), which allows for manually overriding or providing richer descriptions and custom preview images for plugins where the default GitHub information is insufficient.
      - `update-registry.js` then processes this combined information and generates the [`./src/data/registry-users.tsx`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/src/data/registry-users.tsx) file. This file exports the `registryUsers` array, which contains structured data for each plugin (title, description, preview image, website/source links, tags).
      - The [`./src/data/users.tsx`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/src/data/users.tsx) file imports `registryUsers`, defines tag types (like `favorite`, `adapter`, `client`, `plugin`), and provides sorting logic for how plugins are displayed.
      - Finally, the [`./src/pages/showcase/index.tsx`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/src/pages/showcase/index.tsx) page (along with its helper components in [`./src/pages/showcase/_components/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/pages/showcase/_components/)) consumes this data to render the interactive showcase page at [eliza.how/packages](https://eliza.how/packages).
        - While not directly part of `update-registry.js`, the [`./scripts/plugin_summary_prompt.txt`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/scripts/plugin_summary_prompt.txt) serves as a template for AI-driven summarization. This prompt can be used with the [`./scripts/summarize.sh`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/scripts/summarize.sh) script (e.g., `bash ./scripts/summarize.sh -i <path_to_plugin_readme> -p ./scripts/plugin_summary_prompt.txt`) to help generate standardized summaries for plugin READMEs or to populate the descriptions in `plugin-descriptions.json`.
    - Partners & Community: Information related to our ecosystem partners and community initiatives, accessible at [eliza.how/partners](https://eliza.how/partners). The individual partner pages are managed as follows:
      - Partner data (name, description, logo, website, social links, etc.) is maintained in the [`./src/data/partners.tsx`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/src/data/partners.tsx) file.
      - The [`./scripts/update-partner-pages.js`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/scripts/update-partner-pages.js) script reads this data file.
      - For each partner, the script generates a standardized Markdown page (e.g., `index.md`) within a dedicated subdirectory in [`./partners/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/partners/) (e.g., `./partners/<partner-slug>/index.md`).
      - This ensures partner pages are consistent and easily updated by modifying the central `partners.tsx` data source, with the script handling the regeneration of the Markdown files.
      - Community-related content, such as video tutorials, talks, and showcases, is often presented using custom React components like the [`VideoGallery`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/components/VideoGallery) found in [`./src/components/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/src/components/). The content for such galleries (video links, titles, descriptions, thumbnails) is typically managed within the component itself or a dedicated data file it consumes.
    - Blog & News: Articles, updates, and aggregated news in [`./blog/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/blog/) and [`./news/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/news/).
      - News articles are automatically fetched and updated by the [`./scripts/update-news.sh`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/scripts/update-news.sh) script.
      - This script is orchestrated by the [`.github/workflows/update-news.yml`](../../.github/workflows/update-news.yml) GitHub workflow, which typically runs daily.
      - The script maintains the most recent 14 days of news in the [`./news/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/news/) directory.
  - Developer-written JSDoc comments within TypeScript source code (primarily in [`../core/src/`](https://github.com/elizaOS/eliza/tree/develop/packages/core/src/)), which serve as the source for the API Reference.
  - OpenAPI specifications (e.g., [`./src/openapi/eliza-v1.yaml`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/src/openapi/eliza-v1.yaml)) defining REST APIs.
- **Automated Generation & Transformation:**
  - The `docusaurus-plugin-typedoc` (configured in [`./docusaurus.config.ts`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/docusaurus.config.ts)) processes JSDoc comments from source code into browsable API documentation, output to [`./api/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/api/).
  - The `docusaurus-plugin-openapi-docs` (configured in [`./docusaurus.config.ts`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/docusaurus.config.ts)) converts OpenAPI specification files into REST API documentation, output to [`./docs/rest/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/docs/rest/).
  - The `repomix` tool, driven by the [`.github/workflows/llmstxt-generator.yml`](../../.github/workflows/llmstxt-generator.yml) workflow and configured via [`../../scripts/repomix.config.json`](../../scripts/repomix.config.json) & [`../../scripts/repomix-full.config.json`](../../scripts/repomix-full.config.json), generates consolidated AI context files. These are output to [`./static/llms.txt`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/static/llms.txt) (community-focused) and [`./static/llms-full.txt`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/static/llms-full.txt) (technical focus).
  - The `autodoc` package ([`../autodoc/README.md`](../../packages/autodoc/README.md)), leveraged by the [`.github/workflows/jsdoc-automation.yml`](../../.github/workflows/jsdoc-automation.yml) workflow, assists in generating JSDoc comment skeletons for source code.
  - AI-driven translation of the root project [README.md](../../README.md) is handled by the [`.github/workflows/generate-readme-translations.yml`](../../.github/workflows/generate-readme-translations.yml) workflow, with outputs stored in [`./i18n/readme/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/i18n/readme/).
  - Various custom scripts residing in [`./scripts/`](https://github.com/elizaOS/eliza/tree/develop/packages/docs/scripts/README.md) (e.g., [`get-changelog.py`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/scripts/get-changelog.py), [`update-partner-pages.js`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/scripts/update-partner-pages.js)) handle updates for specific documentation sections.
- **CI/CD Validation & Build Pipeline (GitHub Actions):**
  - Workflows such as [`ci.yaml`](../../.github/workflows/ci.yaml) and [`pr.yaml`](../../.github/workflows/pr.yaml) (defined in [`.github/workflows/`](../../.github/workflows/README.md)) trigger on code pushes and pull requests to the repository.
  - These CI pipelines execute essential checks including Markdown linting, broken link detection, and a full Docusaurus site build (`bun run build` within this `packages/docs` directory).
- **Deployment & Delivery:**
  - Upon successful validation and merge to the main branch, the Docusaurus site is automatically built and deployed (typically via `gh-pages` as configured in [`./docusaurus.config.ts`](https://github.com/elizaOS/eliza/blob/develop/packages/docs/docusaurus.config.ts)) to [eliza.how/docs](https://eliza.how/docs).
  - All generated artifacts, including API documentation, news articles, and AI context files, are versioned and become part of the deployed documentation site.
- **Iterative Refinement & Monitoring:**
  - Continuous monitoring of GitHub Actions workflow success, documentation build times, and overall site health.
  - Manual review cycles for AI-generated content (such as JSDoc suggestions and language translations) to ensure quality and accuracy.
  - Community feedback via GitHub Issues and Pull Requests on the main repository is crucial for driving improvements to both the documentation content and the automation processes.

## Local Verification & Manual Triggers

### Verifying Documentation Locally

To ensure your documentation changes are correct and render as expected before pushing, you can run the Docusaurus development server locally:

```bash
# Navigate to the docs package directory if you are not already there
cd packages/docs

# Install dependencies (if you haven't already or if they changed)
bun i

# Start the Docusaurus development server
bun run dev
```

This will typically make the local development site available at `http://localhost:3000` (Docusaurus will confirm the port in the console output).

Alternatively, for a full build similar to the CI process:

```bash
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
