# GitHub Actions Workflows

This directory contains all the GitHub Actions workflows for the Eliza project. These workflows automate various aspects of the development lifecycle, including testing, building, deployment, documentation updates, and security checks.

Below is a summary of the existing workflows:

## CI/CD & Testing

- **`ci.yaml`**: Handles general Continuous Integration tasks, likely running linters, and basic checks on pushes and pull requests.
- **`cli-tests.yml`**: Executes tests specifically for the CLI package (`packages/cli`).
- **`core-package-tests.yaml`**: Runs unit tests for core backend packages (core, server, plugins) excluding CLI and client packages.
- **`client-cypress-tests.yml`**: Runs Cypress component and E2E tests for the client package.
- **`plugin-sql-tests.yaml`**: Tests specifically for the SQL plugin package.
- **`pr.yaml`**: Defines checks and processes that run on every pull request to `main` or `develop` branches.
- **`tauri-ci.yml`**: Manages Continuous Integration for the Tauri desktop application, including building and testing across different platforms.

## Releases & Deployment

- **`pre-release.yml`**: Automates the process of creating pre-releases.
- **`release.yaml`**: Automates the official release process.
- **`tauri-release.yml`**: Handles the release process for the Tauri desktop application, including building binaries and creating GitHub releases.
- **`plugin-publish.yml`**: Automates the publishing of plugins, likely to a package registry.
- **`tee-build-deploy.yml`**: Manages the build and deployment process for the Trusted Execution Environment (TEE) components.
- **`image.yaml`**: Builds and possibly pushes Docker images for various services or applications within the project.

## Documentation Automation

- **`llmstxt-generator.yml`**: Automatically generates/updates `llms.txt` and `llms-full.txt` files (located in `packages/docs/static/`) using the `repomix` tool. These files are used as context for AI models. See the [Repomix Documentation Generator Workflow rule](.cursor/rules/llmstxt-generator-workflow.mdc) for more details.
- **`jsdoc-automation.yml`**: Automates the generation of JSDoc comments for TypeScript code and potentially updates README files using the `autodoc` package. See the [JSDoc Automation Workflow rule](.cursor/rules/jsdoc-automation-workflow.mdc) for details.
- **`generate-readme-translations.yml`**: Translates the root `README.md` file into multiple languages using an AI model and commits the translations. See the [README Translation Workflow rule](.cursor/rules/readme-translation-workflow.mdc) for more details.
- **`update-news.yml`**: Fetches and updates news articles in the documentation (`packages/docs/news/`). This likely involves running the `packages/docs/scripts/update-news.sh` script.

## Security

- **`codeql.yml`**: Implements CodeQL analysis to find security vulnerabilities in the codebase.

These workflows are crucial for maintaining code quality, ensuring stability, and automating repetitive tasks.
