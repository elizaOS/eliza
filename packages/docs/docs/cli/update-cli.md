---
sidebar_position: 12
title: Update CLI Command
description: Update the globally installed ElizaOS CLI to the latest version
keywords: [CLI, update, install, global, maintenance, version]
image: /img/cli.jpg
---

# Update CLI Command

The `update-cli` command updates your globally installed ElizaOS Command Line Interface (CLI) to the latest published version.

**Important:** This command only works if you have installed the ElizaOS CLI globally (e.g., using `npm install -g @elizaos/cli`). It will not work for local project installations or when run via `npx` or `bunx`.

## Usage

```bash
elizaos update-cli
```

## Options

This command does not accept any options.

## Update Process

When you run `update-cli`:

1.  It checks if the CLI is installed globally. If not, it exits.
2.  It determines the currently installed CLI version.
3.  It queries npm to find the latest published version of `@elizaos/cli`.
4.  If the installed version is already the latest, it informs you and exits.
5.  If an update is available, it installs the specific latest version globally (e.g., using `npm install -g @elizaos/cli@<latest_version>`).
6.  It confirms the update status.

## Example

```bash
elizaos update-cli
```

Example output (versions may vary):

```
Checking for ElizaOS CLI updates...
Updating ElizaOS CLI from 1.3.5 to 1.4.0...
Updating Eliza CLI to version: 1.4.0
Successfully updated Eliza CLI to 1.4.0
Please restart your terminal for the changes to take effect.
ElizaOS CLI has been successfully updated!
```

If already up-to-date:

```
Checking for ElizaOS CLI updates...
ElizaOS CLI is already up to date!
```

## Troubleshooting

- **Not Globally Installed:** If you see a message like "The update command is only available for globally installed CLI," you need to install the CLI globally first (`npm install -g @elizaos/cli`) or update your local version manually within your project.
- **Permissions Issues:** Global installations might require administrator privileges (e.g., using `sudo` on Linux/macOS). If the update fails, try running the command with `sudo`.
- **Network Issues:** Ensure you have a stable internet connection to reach npm.
