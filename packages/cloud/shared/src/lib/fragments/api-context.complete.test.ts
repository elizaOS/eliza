/** Proves generated API prompt context has no implicit endpoint or example-parameter window. */
import { describe, expect, it } from "vitest";
import { API_ENDPOINTS } from "../swagger/endpoint-discovery";
import { buildApiContext } from "./api-context";

describe("buildApiContext completeness", () => {
  it("includes every discovered endpoint when no explicit limit is requested", async () => {
    const context = await buildApiContext({ includeExamples: false });
    for (const endpoint of API_ENDPOINTS) {
      expect(context).toContain(`## ${endpoint.name}`);
      expect(context).toContain(`**${endpoint.method}** \`${endpoint.path}\``);
    }
  });

  it("rejects an invalid explicit limit instead of silently clamping it", async () => {
    await expect(buildApiContext({ limit: 0 })).rejects.toThrow(
      "positive safe integer",
    );
  });

  it("includes every body parameter in generated request examples", async () => {
    const endpoint = API_ENDPOINTS.find(
      (candidate) => (candidate.parameters?.body?.length ?? 0) > 3,
    );
    expect(endpoint).toBeDefined();
    const context = await buildApiContext({
      categories: endpoint ? [endpoint.category] : [],
      includeExamples: true,
    });
    for (const parameter of endpoint?.parameters?.body ?? []) {
      if (parameter.example !== undefined || parameter.defaultValue !== undefined) {
        expect(context).toContain(`"${parameter.name}"`);
      }
    }
  });
});
