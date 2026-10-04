import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { runFinalCheck } from "./index.ts";

it("uses the runtime-owned Google endpoint and rejects malformed absence evidence", async () => {
  let ledger: unknown = { malformed: true };
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(ledger));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const runtime = { getSetting: () => `http://127.0.0.1:${address.port}` };
  const check = { type: "gmailMessageSent", expected: false } as const;
  try {
    await expect(
      runFinalCheck(check, { runtime, ctx: { actionsCalled: [] } }),
    ).rejects.toThrow("Malformed");
    ledger = { requests: [] };
    expect(
      (await runFinalCheck(check, { runtime, ctx: { actionsCalled: [] } }))
        .status,
    ).toBe("passed");
    ledger = {
      requests: [
        {
          method: "POST",
          path: "/gmail/v1/users/me/messages/send",
          body: { raw: "complete" },
        },
      ],
    };
    expect(
      (await runFinalCheck(check, { runtime, ctx: { actionsCalled: [] } }))
        .status,
    ).toBe("failed");
    expect(
      (
        await runFinalCheck(
          { type: "gmailApproval", state: "confirmed" },
          { runtime, ctx: { actionsCalled: [] } },
        )
      ).status,
    ).toBe("passed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
