import { describe, expect, it } from "vitest";
import { ElizaClient } from "../client-base";
import "../client-wallet";

function clientFor(reply: (url: string) => unknown) {
  const client = new ElizaClient("https://cloud.example");
  client.setRequestTransport({ request: async (url) => new Response(JSON.stringify(reply(String(url))), { status: 200, headers: { "Content-Type": "application/json" } }) });
  return client;
}
describe("pending approval pages", () => {
  it("retains entries beyond the first server page", async () => {
    const rows = Array.from({ length: 123 }, (_, i) => ({ queueId: String(i) }));
    const offsets: number[] = [];
    const client = clientFor(url => {
      const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
      offsets.push(offset);
      return { approvals: rows.slice(offset, offset + 50), total: rows.length, offset, limit: 50 };
    });
    expect(await client.getStewardPending()).toEqual(rows);
    expect(offsets).toEqual([0, 50, 100]);
  });
  it("preserves complete legacy arrays", async () => {
    const rows = [{ queueId: "legacy" }];
    expect(await clientFor(() => rows).getStewardPending()).toEqual(rows);
  });
  it.each([{}, null, { approvals: [], total: 1, offset: 0, limit: 50 }])("rejects missing or incomplete pages", async reply => {
    await expect(clientFor(() => reply).getStewardPending()).rejects.toThrow("Invalid pending approvals response");
  });
});
