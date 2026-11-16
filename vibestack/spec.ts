#!/usr/bin/env node
import module from "node:module";

module.enableCompileCache?.();
await (await import("./pipeline.ts")).main();
