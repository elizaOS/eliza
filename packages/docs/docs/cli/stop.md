---
sidebar_position: 15 # Adjust position as needed
title: Stop Command
description: Stop all locally running ElizaOS processes
keywords: [CLI, stop, terminate, process, pkill]
image: /img/cli.jpg
---

# Stop Command

The `stop` command attempts to stop all ElizaOS processes currently running on your local machine.

## Usage

```bash
elizaos stop
```

## Behavior

When executed, this command performs the following actions:

1.  Logs an informational message indicating it's starting the stop process.
2.  Uses the `pkill` command internally with a pattern (`pkill -f "node.*elizaos"`) to find and terminate processes that match the typical execution signature of ElizaOS applications run via Node.js.
3.  Outputs a success message (`Server shutdown complete`) if the `pkill` command executes without error.
4.  Outputs an error message if `pkill` encounters an issue.

**Note:** This command relies on `pkill` and process name matching. Its effectiveness might vary depending on how ElizaOS processes were started and the operating system environment.

## Options

This command does not accept any options.

## Related Commands

- [`start`](./start.md): Start your project.
- [`dev`](./dev.md): Run your project in development mode.
