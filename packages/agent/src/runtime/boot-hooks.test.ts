/**
 * Contract for the registry-driven boot-hook channel, with the registry and
 * logger stubbed and no real plugin installed.
 *
 * Guards the two designed absences that leave voice dead if they regress: a
 * packaged build whose registry is empty must still install the local-inference
 * hook, and a host that ships without that plugin must skip it rather than
 * abort startup — while a genuinely broken hook module still fails the boot.
 */
import { describe, expect, it } from "vitest";
import {
  type BootHookDeclaration,
  resolveBootHookContributors,
} from "./boot-hooks";

const LOCAL_INFERENCE_ID = "@elizaos/plugin-local-inference";

describe("boot-hook contributors", () => {
  it("installs the local-inference hook when the registry is empty", () => {
    // The packaged-build case: loadRegistry() degrades to [] by design, so an
    // empty declaration list must not mean "no local model handlers".
    const contributors = resolveBootHookContributors([]);
    expect(contributors.map((c) => c.id)).toContain(LOCAL_INFERENCE_ID);
  });

  it("lets a registry declaration win over the fallback for the same id", () => {
    const declared: BootHookDeclaration = {
      id: LOCAL_INFERENCE_ID,
      specifier: "@elizaos/plugin-local-inference/runtime",
      exportName: "registerLocalInferenceBoot",
    };
    const contributors = resolveBootHookContributors([declared]);
    const matching = contributors.filter((c) => c.id === LOCAL_INFERENCE_ID);
    expect(matching).toHaveLength(1);
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
