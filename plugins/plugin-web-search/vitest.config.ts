/** Runs the public search transport through the owning package test lane. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

const workspaceAliases = buildWorkspaceSourceAliases();

export default defineConfig({
    resolve: { alias: workspaceAliases },
    test: {
        environment: "node",
        alias: workspaceAliases,
        include: ["src/**/*.test.ts"],
    },
});
