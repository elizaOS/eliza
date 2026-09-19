/**
 * Exercises boot-hook selection and dynamic invocation with deterministic
 * declarations, a data-module hook, and an absent optional package.
 */
import { describe, expect, it } from "vitest";
import {
  type BootHookDeclaration,
  resolveBootHookContributors,
} from "./boot-hooks";

const LOCAL_INFERENCE_ID = "@elizaos/plugin-local-inference";

describe("boot-hook contributors", () => {
  it("selects a fallback declaration when the registry is empty", () => {
    // The packaged-build case: loadRegistry() degrades to [] by design, so an
    // empty declaration list must not mean "no local model handlers".
    const contributors = resolveBootHookContributors([]);
    expect(contributors.map((c) => c.id)).toContain(LOCAL_INFERENCE_ID);
  });

  it("invokes the registry override once instead of the fallback", async () => {
    const declared: BootHookDeclaration = {
      id: LOCAL_INFERENCE_ID,
      specifier:
        "data:text/javascript,export function register(runtime) { runtime.hookRuns += 1; }",
      exportName: "register",
    };
    const contributors = resolveBootHookContributors([declared]);
    const matching = contributors.filter((c) => c.id === LOCAL_INFERENCE_ID);
    const runtime = { hookRuns: 0 };
    for (const contributor of matching)
      await contributor.invoke(runtime as never);
    expect(runtime.hookRuns).toBe(1);
  });

  it("skips a hook whose own module is not installed", async () => {
    const contributors = resolveBootHookContributors([
      {
        id: "absent-plugin",
        specifier: "@elizaos/definitely-not-installed/runtime",
        exportName: "register",
      },
    ]);
    const contributor = contributors.find((c) => c.id === "absent-plugin");
    expect(contributor).toBeDefined();
    // A supported deployment without the optional plugin: skip, do not throw.
    await expect(contributor?.invoke({} as never)).resolves.toBeUndefined();
  });
});
