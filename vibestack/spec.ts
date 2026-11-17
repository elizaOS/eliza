#!/usr/bin/env node
import module from "node:module";

const compiled = module.enableCompileCache?.();
if (compiled?.directory) process.env.NODE_COMPILE_CACHE ??= compiled.directory;
await (await import("./pipeline.ts")).main();
