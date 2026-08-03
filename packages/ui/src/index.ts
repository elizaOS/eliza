/**
 * Stable common surface for `@elizaos/ui`.
 *
 * Feature domains are published through explicit subpaths so importing a
 * primitive never evaluates the app shell, clients, cloud console, native
 * bridges, or feature registries. New exports belong on their owning subpath;
 * this root remains limited to the canonical design-system primitives.
 */

export * from "./components/primitives/index";
export { cn } from "./lib/utils";
