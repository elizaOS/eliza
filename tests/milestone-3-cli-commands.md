# Milestone 3: CLI Commands - Daily Operations

This milestone tests every example for every CLI command to ensure they work as documented. Each command should be tested in a clean project directory.

## 1. `elizaos create` (`cli/create.md`)
- [ ] Test interactive creation: `elizaos create`
- [ ] Test quick creation with defaults: `elizaos create -y`
- [ ] Test creating a plugin: `elizaos create -t plugin`
- [ ] Test creating an agent file: `elizaos create -t agent my-char`
- [ ] Test creating a TEE project: `elizaos create -t tee`
- [ ] Test creating in a custom directory: `elizaos create -d ./test-dir`
- [ ] Test creation with `--no-install`
- [ ] Test creation with `--no-git`

## 2. `elizaos start` (`cli/start.md`)
- [ ] Test basic start: `elizaos start`
- [ ] Test starting on a custom port: `elizaos start --port 8080`
- [ ] Test starting with a build: `elizaos start --build`
- [ ] Test force reconfiguration: `elizaos start --configure`
- [ ] Test starting with a specific character file: `elizaos start --character ./my-char.json`
- [ ] Test starting with multiple character files.
- [ ] Test starting with `--quiet` flag.

## 3. `elizaos dev` (`cli/dev.md`)
- [ ] Test basic dev mode: `elizaos dev`
- [ ] Test dev mode with a custom port: `elizaos dev --port 8080`
- [ ] Test dev mode with `--no-open` flag.
- [ ] Test file watching by changing a `src/` file and verifying server restarts.

## 4. `elizaos test` (`cli/test.md`)
- [ ] Test running all tests: `elizaos test`
- [ ] Test running component tests only: `elizaos test component`
- [ ] Test running e2e tests only: `elizaos test e2e`
- [ ] Test filtering by name: `elizaos test --name my-test-suite`
- [ ] Test `--watch` mode.
- [ ] Test `--coverage` report generation.

## 5. `elizaos agent` (`cli/agent.md`)
- [ ] Test `elizaos agent list`
- [ ] Test `elizaos agent list --format json`
- [ ] Test `elizaos agent get --name <name>`
- [ ] Test `elizaos agent get --name <name> --output`
- [ ] Test `elizaos agent start --path <path>`
- [ ] Test `elizaos agent stop --name <name>`
- [ ] Test `elizaos agent remove --name <name>`
- [ ] Test `elizaos agent set --name <name> --config '{...}'`

## 6. `elizaos env` (`cli/env.md`)
- [ ] Test `elizaos env list`
- [ ] Test `elizaos env list --show-values`
- [ ] Test `elizaos env edit-local`
- [ ] Test `elizaos env interactive`
- [ ] Test `elizaos env reset` (interactive)
- [ ] Test `elizaos env reset -y` (non-interactive)

## 7. `elizaos plugins` (`cli/plugins.md`)
- [ ] Test `elizaos plugins list`
- [ ] Test `elizaos plugins add openai`
- [ ] Test `elizaos plugins add some-plugin --dev`
- [ ] Test `elizaos plugins add some-plugin --force`
- [ ] Test `elizaos plugins remove openai`
- [ ] Test `elizaos plugins update`

## 8. `elizaos publish` (`cli/publish.md`)
- [ ] Test `elizaos publish --test`
- [ ] Test `elizaos publish --dry-run`
- [ ] Test `elizaos publish --npm`
- [ ] Test `elizaos publish --skip-registry`

## 9. `elizaos update` (`cli/update.md`)
- [ ] Test `elizaos update --check`
- [ ] Test `elizaos update --cli`
- [ ] Test `elizaos update --packages`
- [ ] Test a full `elizaos update` flow. 