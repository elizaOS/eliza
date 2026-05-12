import { describe, expect, test } from "bun:test";
import { GET as getConnectionToken } from "@/apps/api/v1/oauth/connections/[id]/token/route";
import { GET as getPlatformToken } from "@/apps/api/v1/oauth/token/[platform]/route";

describe("public OAuth token routes", () => {
  test("connection token route is removed", async () => {
    const response = await getConnectionToken();

    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
  });

  test("platform token route is removed", async () => {
    const response = await getPlatformToken();

    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
  });
});
