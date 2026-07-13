import { ProjectsPageView } from "@elizaos/ui/components/pages/ProjectsPageView";
import { describe, expect, it } from "vitest";
import {
  renderInternalToolTab,
  resolveInternalToolTabFromSlug,
} from "./AppWindowRenderer";

describe("AppWindowRenderer internal tools", () => {
  it("resolves the canonical Projects window and its retired Tasks alias", () => {
    expect(resolveInternalToolTabFromSlug("projects")).toBe("projects");
    expect(resolveInternalToolTabFromSlug("tasks")).toBe("projects");
  });

  it("renders Projects for both canonical and legacy tab ids", () => {
    expect(renderInternalToolTab("projects")?.type).toBe(ProjectsPageView);
    expect(renderInternalToolTab("tasks")?.type).toBe(ProjectsPageView);
  });

  it("keeps nested app tools and rejects unknown slugs", () => {
    expect(resolveInternalToolTabFromSlug("plugins")).toBe("plugins");
    expect(resolveInternalToolTabFromSlug("missing")).toBeNull();
  });
});
