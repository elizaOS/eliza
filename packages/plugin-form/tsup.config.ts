import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    skipNodeModulesBundle: true,
    noExternal: ["viem"],
});
