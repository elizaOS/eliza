/**
 * Verifies the managed Discord bot's deterministic identity-link interception
 * and its authenticated Cloud confirm contract with injected HTTP responses.
 */
import { describe, expect, test } from "bun:test";
import { tryConfirmDiscordIdentityLink } from "../src/identity-link";

function harness(response: Response) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  return {
    requests,
    deps: {
      cloudBaseUrl: "https://cloud.example",
      getAuthHeader: () => ({ Authorization: "Bearer gateway-jwt" }),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return response;
      }) as typeof fetch,
    },
  };
}

describe("tryConfirmDiscordIdentityLink", () => {
  test("passes ordinary Discord messages through without HTTP", async () => {
    const { deps, requests } = harness(Response.json({ success: true }));
    expect(
      await tryConfirmDiscordIdentityLink(deps, {
        text: "hello",
        discordUserId: "123",
        discordUsername: "sam",
      }),
    ).toEqual({ handled: false });
    expect(requests).toHaveLength(0);
  });

  test("attests the Discord sender and returns the linked reply", async () => {
    const { deps, requests } = harness(Response.json({ success: true }));
    const result = await tryConfirmDiscordIdentityLink(deps, {
      text: "please use link-abcdefgh thanks",
      discordUserId: "123",
      discordUsername: "sam",
    });
    expect(result).toMatchObject({ handled: true, linked: true });
    expect(requests).toEqual([
      {
        url: "https://cloud.example/api/eliza-app/identity-link/confirm",
        body: {
          code: "LINK-ABCDEFGH",
          platform: "discord",
          platformId: "123",
          platformName: "sam",
        },
      },
    ]);
  });

  test("returns typed conflict copy and throws on infrastructure failure", async () => {
    const conflict = harness(
      Response.json(
        { success: false, data: { status: "handle_conflict" } },
        { status: 409 },
      ),
    );
    const rejected = await tryConfirmDiscordIdentityLink(conflict.deps, {
      text: "LINK-ABCDEFGH",
      discordUserId: "123",
      discordUsername: "sam",
    });
    expect(rejected).toMatchObject({ handled: true, linked: false });
    expect(rejected.handled && rejected.reply).toContain(
      "different eliza.app account",
    );

    const failed = harness(new Response("unavailable", { status: 503 }));
    await expect(
      tryConfirmDiscordIdentityLink(failed.deps, {
        text: "LINK-ABCDEFGH",
        discordUserId: "123",
        discordUsername: "sam",
      }),
    ).rejects.toThrow("Discord identity-link confirm failed (503)");
  });
});
