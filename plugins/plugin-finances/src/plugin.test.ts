/**
 * Finances plugin contract tests pin the view registration and named component
 * export consumed by the app view loader.
 */

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
    // The loader resolves this named export from the built view bundle.
    expect(typeof FinancesView).toBe("function");
    expect(FinancesView.name).toBe(view?.componentExport);
    expect(FinancesView.name).toBe("FinancesView");
  });
});
