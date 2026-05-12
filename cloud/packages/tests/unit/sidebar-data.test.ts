import { describe, expect, test } from "bun:test";

import { sidebarSections } from "../../../apps/frontend/src/components/layout/sidebar-data";

describe("sidebarSections", () => {
  test("places Infrastructure directly under Dashboard with Instances first", () => {
    expect(sidebarSections.length).toBeGreaterThan(1);

    const [dashboardSection, infrastructureSection] = sidebarSections;

    expect(dashboardSection?.title).toBeUndefined();
    expect(dashboardSection?.items.map((item) => item.label)).toEqual(["Dashboard"]);

    expect(infrastructureSection?.title).toBe("Infrastructure");
    expect(infrastructureSection?.items.map((item) => item.label)).toEqual([
      "Instances",
      "MCPs",
      "Containers",
    ]);
    expect(infrastructureSection?.items[0]?.href).toBe("/dashboard/agents");
    expect(infrastructureSection?.items[2]?.href).toBe("/dashboard/containers");
  });

  test("exposes Containers as an Infrastructure sidebar item", () => {
    const infrastructureSection = sidebarSections.find(
      (section) => section.title === "Infrastructure",
    );
    expect(infrastructureSection?.items.some((item) => item.label === "Containers")).toBe(true);
  });
});
