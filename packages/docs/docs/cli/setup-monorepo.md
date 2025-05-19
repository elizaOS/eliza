---
sidebar_position: 10
title: Setup Monorepo Command
description: Clone the ElizaOS monorepo for development or contribution
keywords: [monorepo, setup, clone, git, development, contribution]
image: /img/cli.jpg
---

# Setup Monorepo Command

The `setup-monorepo` command is a utility to clone the main ElizaOS monorepo (`elizaOS/eliza`) from GitHub. This is useful for developers who want to contribute to ElizaOS or set up a full development environment.

## Usage

```bash
elizaos setup-monorepo [options]
```

## Options

| Option                  | Description                         | Default      |
| ----------------------- | ----------------------------------- | ------------ |
| `-b, --branch <branch>` | Branch to clone                     | `v2-develop` |
| `-d, --dir <directory>` | Destination directory for the clone | `./eliza`    |

## Functionality

1.  **Checks Destination**: Verifies if the target directory specified by `-d` exists. If it exists, it must be empty. If it doesn't exist, it will be created.
2.  **Clones Repository**: Clones the `elizaOS/eliza` repository from GitHub using the branch specified by `-b`.
3.  **Displays Next Steps**: After successful cloning, it provides instructions on how to proceed:
    - Navigate into the cloned directory (`cd <directory>`).
    - Install dependencies (`bun install`).
    - Build the project (`bun run build`).
    - Start the development server (`bun run dev`) or production server (`bun run start`).

The command will properly use your specified branch and directory path, making it easy to work with different versions of the ElizaOS repository.

## Example

```bash
# Clone the default 'v2-develop' branch into the default './eliza' directory
elizaos setup-monorepo

# Clone the 'main' branch into a specific directory 'my-eliza-dev'
elizaos setup-monorepo --branch main --dir my-eliza-dev
```

This command simplifies the initial setup process for working directly with the ElizaOS monorepo source code.
