/**
 * Locks the invariant that every always-loaded plugin ships in the packaged
 * runtime bundle.
 *
 * `MOBILE_VIEW_PLUGINS` (`viewEveryPlatform: true`) are loaded on every
 * platform so their home tiles resolve. When one is missing from the bundle the
 * packaged build does not degrade gracefully: the plugin fails to resolve,
 * `plugin-personal-assistant`'s lifeops routes throw on the absent
 * `@elizaos/plugin-calendar`, and the post-ready app-route tail fails. That
 * pins `/api/health` `startup.phase` at "degraded", and the desktop shell's
 * boot-progress gate — which advances only on phase "running" — never reports
 * the runtime ready, so the app renders no UI.
 *
 * A baseline entry only takes effect when the package is also resolvable as a
 * dependency of this one, because `getBundledRuntimePackages` intersects the
 * baseline with the available dependencies.
 *
 * `@elizaos/plugin-inbox` is deliberately NOT an `@elizaos/agent` dependency:
 * it depends on `@elizaos/app-core`, which depends on `@elizaos/agent`, so
 * declaring it here creates a Turbo build cycle
 * (`agent -> plugin-inbox -> app-core -> agent`). It reaches the packaged
 * runtime as a hard dependency of `@elizaos/plugin-personal-assistant`, which
 * the runtime-copy transitive walk keeps because the edge is `required`.
 */
import { describe, expect, it } from "vitest";
import agentPackageJson from "../../package.json" with { type: "json" };
import { MOBILE_VIEW_PLUGINS } from "./core-plugins.ts";
import {
  BASELINE_BUNDLED_RUNTIME_PACKAGES,
  getBundledRuntimePackages,
} from "./release-plugin-policy.ts";

const declaredDependencies = Object.keys(
  (agentPackageJson as { dependencies?: Record<string, string> })
    .dependencies ?? {},
);

/**
 * Would close `agent -> plugin-inbox -> app-core -> agent`, so it ships through
 * the transitive walk instead of a direct dependency here.
 */
const CYCLE_EXCLUDED_FROM_AGENT_DEPS = new Set(["@elizaos/plugin-inbox"]);

const AGENT_DECLARABLE_VIEW_PLUGINS = MOBILE_VIEW_PLUGINS.filter(
  (name) => !CYCLE_EXCLUDED_FROM_AGENT_DEPS.has(name),
);

describe("always-loaded view plugins ship in the runtime bundle", () => {
  it("declares each one as a workspace dependency of @elizaos/agent", () => {
    const missing = AGENT_DECLARABLE_VIEW_PLUGINS.filter(
      (name) => !declaredDependencies.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it("lists each one in the baseline bundled packages", () => {
    const baseline = new Set(BASELINE_BUNDLED_RUNTIME_PACKAGES);
    const missing = MOBILE_VIEW_PLUGINS.filter((name) => !baseline.has(name));
    expect(missing).toEqual([]);
  });

  it("resolves each declarable one as bundled for the real dependency set", () => {
    const bundled = new Set(getBundledRuntimePackages(declaredDependencies));
    const missing = AGENT_DECLARABLE_VIEW_PLUGINS.filter(
      (name) => !bundled.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the cycle-excluded plugin out of this package's dependencies", () => {
    for (const name of CYCLE_EXCLUDED_FROM_AGENT_DEPS) {
      expect(declaredDependencies).not.toContain(name);
    }
  });

  it("covers the plugin whose absence broke desktop startup", () => {
    // plugin-personal-assistant imports this eagerly from its lifeops routes.
    expect(
      getBundledRuntimePackages(declaredDependencies).includes(
        "@elizaos/plugin-calendar",
      ),
    ).toBe(true);
  });
});
