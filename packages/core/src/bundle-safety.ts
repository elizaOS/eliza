/**
 * Bundle-safety anchor — mobile-bundle tree-shaking workaround.
 *
 * `Bun.build` lowers the cyclic `@elizaos/core` module graph to lazy
 * CJS-interop inits for the on-device mobile agent bundle. Under that lowering
 * it DROPS modules that are reachable only through re-export-only barrels,
 * even with `"sideEffects": true` set — the feature silently vanishes from the
 * shipped bundle (a public plugin export becomes an empty init stub plus a
 * dangling namespace getter, so the agent dies at module init with a
 * `ReferenceError` or the whole capability is missing on device).
 *
 * The established workaround is an EAGER anchor: a feature barrel value-imports
 * every binding it must keep and stashes those references on `globalThis`. The
 * `globalThis` write is an unremovable top-level side effect, so Bun.build
 * retains the call, its argument array, and therefore the imported leaf module
 * bodies. This helper centralizes that one-liner so the 15+ feature barrels
 * that need it stop hand-rolling the `const … = [...]; (globalThis as …).… = …`
 * boilerplate.
 *
 * The `name` MUST be unique per barrel — parents that `export *` two anchored
 * barrels would otherwise collide on a shared global key and one barrel's
 * anchor would overwrite the other's.
 *
 * Verified STILL PRESENT on `bun@1.4.0` (the version pinned in the repo's
 * `packageManager`, 2026-07): a minimal `Bun.build --target=browser`
 * reproduction drops an unused re-export-only barrel binding, and the anchor
 * (inline or via this helper, minified or not) retains it. Delete this helper
 * and restore plain barrel re-exports only once a Bun release ships that keeps
 * re-export-only barrel bodies under CJS-interop lowering.
 *
 * Incident tracking (Bun.build barrel-drop): elizaOS/eliza #10727, #11030,
 * #11248, #11276. Upstream: oven-sh/bun tree-shaking of re-export-only modules
 * under lazy CJS-interop lowering.
 */
export function anchorBundleSafety(
	name: string,
	values: readonly unknown[],
): void {
	(globalThis as Record<string, unknown>)[`__bundle_safety_${name}__`] = values;
}
