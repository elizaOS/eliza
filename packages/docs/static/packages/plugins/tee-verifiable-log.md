# Build Plugin

## Purpose

A plugin for building and testing code in ElizaOS.

## Configuration

This plugin depends on plugin-tee. For local testing, a TEE simulator can be set up using Docker. When using the provider through the runtime environment, configure settings like TEE_MODE, WALLET_SECRET_SALT, and VLOG.

## Example Usage

```
bun clean
bun install  or  bun install --no-frozen-lockfile
bun build
```

For testing:

```
bun test
```
