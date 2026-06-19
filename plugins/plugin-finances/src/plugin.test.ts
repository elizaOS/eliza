// Guards the `finances` view registration against the view loader silently
// failing to resolve the component. The view loader matches the registered
// `componentExport` name against a named export in the bundle, so the export
// name and the registration must agree.

import { describe, expect, it } from "vitest";
import { FinancesView } from "./components/finances/FinancesView.tsx";
import { financesPlugin } from "./plugin.ts";

describe("financesPlugin view registration", () => {
  it("registers exactly one view pointing at the /finances dashboard", () => {
    expect(financesPlugin.views).toHaveLength(1);

    const view = financesPlugin.views?.[0];
    expect(view).toBeDefined();
    expect(view?.id).toBe("finances");
    expect(view?.path).toBe("/finances");
    expect(view?.bundlePath).toBe("dist/views/bundle.js");
    expect(view?.componentExport).toBe("FinancesView");
  });

  it("resolves the registered componentExport to the exported component function", () => {
    const view = financesPlugin.views?.[0];
    // The named export the loader looks up must exist and be a component.
    expect(typeof FinancesView).toBe("function");
    // ...and its function name must match the registered componentExport so the
    // bundle's named export resolves.
    expect(FinancesView.name).toBe(view?.componentExport);
    expect(FinancesView.name).toBe("FinancesView");
  });
});
