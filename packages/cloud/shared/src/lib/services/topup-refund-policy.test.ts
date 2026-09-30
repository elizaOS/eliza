/**
 * The x402 top-up payment prompt states that crypto and x402 payments are
 * refundable only as Eliza Cloud credits (#22968), in the payer's locale.
 */
import { describe, expect, test } from "bun:test";
import { createTopupHandler } from "./topup-handler";

const RECIPIENT = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const WALLET = "0x2222222222222222222222222222222222222222";

async function prompt(locale?: string) {
  const handler = createTopupHandler({ amount: 10, getSourceId: () => "topup-10" });
  const response = await handler(
    new Request("https://cloud.example/api/v1/topup/10", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: WALLET }),
    }),
    {
      X402_RECIPIENT_ADDRESS: RECIPIENT,
      X402_NETWORK: "base",
      ...(locale ? { ELIZA_LOCALE: locale } : {}),
    },
  );
  expect(response.status).toBe(402);
  return (await response.json()) as {
    resource: { description: string };
    accepts: Array<{
      description: string;
      extra: { refundPolicy?: { destination: string; statement: string } };
    }>;
  };
}

describe("x402 top-up refund policy (#22968)", () => {
  test("states the credits-only refund policy in the description and extra", async () => {
    const body = await prompt();
    const [requirements] = body.accepts;
    expect(requirements?.extra.refundPolicy).toEqual({
      destination: "cloud_credits",
      statement: "Refunds are issued only as Eliza Cloud credits, never on-chain or to fiat.",
    });
    expect(requirements?.description).toBe(
      "Eliza Cloud credit top-up: $10. Refunds are issued only as Eliza Cloud credits, never on-chain or to fiat.",
    );
    expect(body.resource.description).toBe(requirements?.description);
  });

  test("localizes the policy statement", async () => {
    const body = await prompt("es");
    expect(body.accepts[0]?.extra.refundPolicy).toMatchObject({
      destination: "cloud_credits",
      statement: expect.stringContaining("créditos de Eliza Cloud"),
    });
  });
});
