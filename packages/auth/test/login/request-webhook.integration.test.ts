/** A real SIWE request owns all immediate webhook siblings through shutdown. */
import { expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { startEmbeddedLogin } from "../../src/server/runtime";
import {
  createLocalWebhookFixture,
  latch,
  received,
} from "./local-webhook-fixture";

test("shutdown retains request webhook siblings through a configuration failure", async () => {
  const arrival = latch<{ id: string; eventType: string; verified: boolean }>();
  const release = latch<void>();
  const fixture = await createLocalWebhookFixture(async (delivery) => {
    arrival.resolve(delivery);
    await release.promise;
    return new Response("received");
  });
  let login: Awaited<ReturnType<typeof startEmbeddedLogin>> | undefined;
  let stopping: Promise<void> | undefined;
  let restore: (() => void) | undefined;
  try {
    const { startEmbeddedLogin: start } = await import(
      "../../src/server/runtime"
    );
    const { getDb, isEmbeddedDatabase, webhookConfigs, webhookDeliveries } =
      await import("../../src/server/db/index");
    const { createPGLiteDb } = await import("../../src/server/db/pglite");
    const { PersistentQueue } = await import("../../src/server/webhooks/index");
    const { encryptWebhookSecret } = await import(
      "../../src/server/webhooks/secret-codec"
    );
    login = await start({ port: 0 });
    const origin = "https://eliza.app";
    const base = `http://127.0.0.1:${login.port}`;
    const account = privateKeyToAccount(generatePrivateKey());
    const signIn = async () => {
      const challenge = await fetch(`${base}/auth/nonce`, {
        headers: { Origin: origin },
      });
      expect(challenge.status).toBe(200);
      const { nonce } = await challenge.json();
      const message = [
        "eliza.app wants you to sign in with your Ethereum account:",
        account.address,
        "",
        "Sign in to elizaOS",
        "",
        `URI: ${origin}`,
        "Version: 1",
        "Chain ID: 1",
        `Nonce: ${nonce}`,
        `Issued At: ${new Date().toISOString()}`,
      ].join("\n");
      const response = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          signature: await account.signMessage({ message }),
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { tenant: { id: string } };
    };
    const tenantId = (await signIn()).tenant.id;
    const currentKey = process.env.STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY;
    if (!currentKey) throw new Error("Missing fixture encryption key");
    const encryptedSecret = encryptWebhookSecret(fixture.secret);
    let oldEncryption: string;
    process.env.STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY =
      randomBytes(32).toString("hex");
    try {
      // An existing configuration written under an unavailable key fails its
      // native authentication check while another destination remains usable.
      oldEncryption = encryptWebhookSecret("previous receiver secret");
    } finally {
      process.env.STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY = currentKey;
    }
    await getDb()
      .insert(webhookConfigs)
      .values([
        {
          tenantId,
          url: fixture.url.toString(),
          secret: encryptedSecret,
          events: ["user.authenticated"],
        },
        {
          tenantId,
          url: new URL("/unreadable", fixture.url).toString(),
          secret: oldEncryption,
          events: ["user.authenticated"],
        },
      ]);
    const original = PersistentQueue.prototype.processDelivery;
    const immediate = new Map<string, ReturnType<typeof original>>();
    const observer = spyOn(
      PersistentQueue.prototype,
      "processDelivery",
    ).mockImplementation(function (
      this: InstanceType<typeof PersistentQueue>,
      id,
      tenant,
    ) {
      const receipt = original.call(this, id, tenant);
      immediate.set(id, receipt);
      // The Auth caller observes this rejection through the same real promise.
      void receipt.catch(() => undefined);
      return receipt;
    });
    restore = () => observer.mockRestore();
    // The request returns while the receiver holds the immediate delivery.
    await signIn();
    const { id, eventType, verified } = await received(arrival.promise);
    const receipt = immediate.get(id);
    if (!receipt)
      throw new Error("The request did not own the immediate delivery");
    expect({ eventType, verified }).toEqual({
      eventType: "user.authenticated",
      verified: true,
    });
    expect(await new PersistentQueue().getDelivery(id, tenantId)).toMatchObject(
      { status: "processing", attempts: 1 },
    );
    stopping = login.stop();
    await expect(
      fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) }),
    ).rejects.toBeDefined();
    const shutdown = await Promise.race([
      stopping.then(() => "closed"),
      Bun.sleep(300).then(() => "waiting"),
    ]);
    const storageWhileHeld = isEmbeddedDatabase();
    release.resolve();
    await stopping;
    login = undefined;
    const [result] = await Promise.allSettled([receipt]);
    const readback = await createPGLiteDb();
    try {
      const rows = await readback.db
        .select({
          id: webhookDeliveries.id,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
        })
        .from(webhookDeliveries);
      expect({
        shutdown,
        storageWhileHeld,
        inline: result.status,
        rows,
      }).toEqual({
        shutdown: "waiting",
        storageWhileHeld: true,
        inline: "fulfilled",
        rows: [{ id, status: "delivered", attempts: 1 }],
      });
      expect(
        result.status === "fulfilled" ? result.value : undefined,
      ).toMatchObject({ success: true, statusCode: 200 });
    } finally {
      await readback.client.close();
    }
  } finally {
    release.resolve();
    try {
      await stopping;
      await login?.stop();
    } finally {
      restore?.();
      await fixture.close();
    }
  }
}, 120_000);
