# Integration tests

This directory contains smoke and integration tests for Eliza project.

## Smoke tests

- Should always be run on a freshly cloned project (i.e. no local changes)
- Building and installing is part of the test
- No configuration required
- To run: `bun run smokeTests`

## Integration tests

- You need to configure your .env file before running (currently at least `OPENAI_API_KEY` is required)
- How to use:
    1. Install project dependencies and build the project as described in top-level `README`
    2. To run all the tests: `bun run test`

## Integration test library

- For simplicity, integration tests are written in plain JavaScript (ESM)
- Currently this is just a "proof of concept" (single test), please reach out if you would like to contribute.

## Using in GitHub CI/CD

- Settings -> Secrets and variables -> Actions:
- Create an environment
- Add repository secret `OPENAI_API_KEY`
- Refer to https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions for more information
