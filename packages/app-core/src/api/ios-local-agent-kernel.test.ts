import { describe, expect, it } from "vitest";
import { handleIosLocalAgentRequest } from "./ios-local-agent-kernel";

async function getJson(pathname: string): Promise<unknown> {
  const response = await handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${pathname}`),
  );

  expect(response.status).toBe(200);
  return response.json();
}

describe("handleIosLocalAgentRequest", () => {
  it("matches app catalog response contracts", async () => {
    await expect(getJson("/api/apps")).resolves.toEqual([]);
    await expect(getJson("/api/catalog/apps")).resolves.toEqual([]);
  });

  it("matches plugin and skill list response contracts", async () => {
    await expect(getJson("/api/plugins")).resolves.toEqual({ plugins: [] });
    await expect(getJson("/api/skills")).resolves.toEqual({ skills: [] });
  });
});
