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
    expect(
      (
        await runFinalCheck(
          { type: "gmailApproval", state: "confirmed" },
          { runtime, ctx: { actionsCalled: [] } },
        )
      ).status,
    ).toBe("failed");
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

it("cancels an actual pending ledger request through its caller signal", async () => {
  const bodyStarted = Promise.withResolvers<void>();
  const server = createServer((_request, _response) => {
    bodyStarted.resolve();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const controller = new AbortController();
  const reason = new Error("caller cancelled ledger proof");
  try {
    const pending = runFinalCheck(
      { type: "gmailMessageSent", expected: false },
      {
        runtime: { getSetting: () => `http://127.0.0.1:${address.port}` },
        ctx: { actionsCalled: [] },
        abortSignal: controller.signal,
      },
    );
    const rejected = expect(pending).rejects.toBe(reason);
    await bodyStarted.promise;
    controller.abort(reason);
    await rejected;
    expect(controller.signal.reason).toBe(reason);
  } finally {
    controller.abort(reason);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
