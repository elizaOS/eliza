/** Real canonical connector storage and Google grant projection verify handoff permissions; provider reads are deterministic and no message is sent. */
import { getConnectorAccountManager } from "@elizaos/core";
import { expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { verifyAccountHandoffGoogle } from "./account-handoff-google-verification.js";
import { googleGrantIdForAccount } from "./google-plugin-delegates.js";
import { LifeOpsService } from "./service.js";

it("verifies a canonical Gmail read/send grant, then rejects lost send permission before another provider probe", async () => {
  const host = await createLifeOpsTestRuntime();
  try {
    const manager = getConnectorAccountManager(host.runtime);
    manager.registerProvider({ provider: "google" });
    const saved = await manager.upsertAccount("google", {
      provider: "google",
      id: "canonical-mail",
      role: "OWNER",
      purpose: ["reading", "messaging"],
      accessGate: "owner_binding",
      status: "connected",
      displayHandle: "canonical@example.test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      },
    });
    const service = new LifeOpsService(host.runtime);
    const url = new URL("http://localhost");
    const f = googleHandoffFixture();
    const grantId = googleGrantIdForAccount(saved.id);
    f.review.replacement = {
      grantId,
      connectorAccountId: saved.id,
      email: "canonical@example.test",
    };
    f.review.readCalendars = [];
    f.review.writeCalendar = null;
    f.review.messageDestinations = [
      {
        channel: "email",
        connectorAccountId: saved.id,
        recipientId: "recipient@example.test",
      },
    ];
    const run = () =>
      verifyAccountHandoffGoogle(
        host.runtime.agentId,
        url,
        f.review,
        service,
        f.google,
      );
    const verified = await run();
    expect(verified).toMatchObject({
      connectorAccountId: saved.id,
      grantId,
      gmailHistoryId: "12345",
      writableCalendarId: null,
    });
    expect(f.calls).toEqual([`gmail:${saved.id}`]);
    await manager.upsertAccount("google", {
      ...saved,
      metadata: {
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    });
    await expect(run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
    expect(f.calls).toEqual([`gmail:${saved.id}`]);
  } finally {
    await host.cleanup();
  }
});
