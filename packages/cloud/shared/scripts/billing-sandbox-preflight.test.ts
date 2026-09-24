/** Exercises sandbox account and mode rejection through the real Stripe SDK with controlled HTTP only. */
import { describe, expect, spyOn, test } from "bun:test";
import { Client } from "pg";
import Stripe from "stripe";
import {
  requireRuntimeSandboxConfiguration,
  verifyRuntimeSandboxAccount,
} from "./billing-sandbox-preflight";
import { certifyRuntimeSandbox } from "./certify-generic-billing-runtime-sandbox";

const env = {
  GENERIC_BILLING_SANDBOX_RUN: "1",
  GENERIC_BILLING_STRIPE_TEST_KEY: "sk_test_fixture",
  GENERIC_BILLING_STRIPE_TEST_ACCOUNT: "acct_expected",
  GENERIC_BILLING_STRIPE_TEST_ACCOUNT_KIND: "platform",
  GENERIC_BILLING_SANDBOX_POSTGRES_URL: "postgresql://tester@127.0.0.1:55437/postgres",
  GENERIC_BILLING_SANDBOX_WEBHOOK_SECRET: "whsec_fixture",
};
describe("runtime sandbox preflight", () => {
  test("actual entrypoint rejects missing credentials before database or network access", async () => {
    const connect = spyOn(Client.prototype, "connect").mockImplementation(() => {
      throw new Error("Unexpected database connection");
    });
    const query = spyOn(Client.prototype, "query").mockImplementation(() => {
      throw new Error("Unexpected database mutation");
    });
    const network = spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Unexpected provider request");
    });
    try {
      await expect(
        certifyRuntimeSandbox({ ...env, GENERIC_BILLING_STRIPE_TEST_KEY: undefined }),
      ).rejects.toThrow("dedicated Stripe test");
      await expect(
        certifyRuntimeSandbox({ ...env, GENERIC_BILLING_STRIPE_TEST_KEY: "sk_live_fixture" }),
      ).rejects.toThrow("dedicated Stripe test");
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      query.mockRestore();
      network.mockRestore();
    }
  });
  test("rejects missing credentials without a production fallback", () => {
    expect(() =>
      requireRuntimeSandboxConfiguration({
        ...env,
        GENERIC_BILLING_STRIPE_TEST_KEY: undefined,
        STRIPE_SECRET_KEY: "sk_live_fixture",
      }),
    ).toThrow("dedicated Stripe test");
    expect(() =>
      requireRuntimeSandboxConfiguration({
        ...env,
        GENERIC_BILLING_STRIPE_TEST_KEY: "sk_live_fixture",
      }),
    ).toThrow("dedicated Stripe test");
    expect(() =>
      requireRuntimeSandboxConfiguration({ ...env, GENERIC_BILLING_SANDBOX_RUN: undefined }),
    ).toThrow("GENERIC_BILLING_SANDBOX_RUN");
  });
  test("rejects remote databases and connection options that can bypass schema isolation", () => {
    for (const url of [
      "postgresql://production.example/db",
      "postgresql://localhost/db?host=production.example",
      "postgresql://localhost/db?options=-csearch_path=public",
      "https://localhost/db",
    ])
      expect(() =>
        requireRuntimeSandboxConfiguration({ ...env, GENERIC_BILLING_SANDBOX_POSTGRES_URL: url }),
      ).toThrow("local and have no connection options");
    expect(() =>
      requireRuntimeSandboxConfiguration({
        ...env,
        GENERIC_BILLING_SANDBOX_WEBHOOK_SECRET: undefined,
      }),
    ).toThrow("signature secret");
  });
  for (const scenario of ["foreign", "live", "missing-mode", "valid"] as const)
    test(`authoritative Stripe ${scenario} preflight never writes`, async () => {
      const calls: { method: string; path: string; account: string | null }[] = [];
      const stripe = new Stripe("sk_test_fixture", {
        maxNetworkRetries: 0,
        httpClient: Stripe.createFetchHttpClient(async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          calls.push({
            method: request.method,
            path,
            account: request.headers.get("stripe-account"),
          });
          if (request.method !== "GET") throw new Error("Preflight attempted a mutation");
          return Response.json(
            path.endsWith("/account")
              ? { id: scenario === "foreign" ? "acct_other" : "acct_expected", object: "account" }
              : {
                  object: "balance",
                  ...(scenario === "missing-mode" ? {} : { livemode: scenario === "live" }),
                },
          );
        }),
      });
      if (scenario === "valid")
        await verifyRuntimeSandboxAccount(stripe, { account: "acct_expected" });
      else
        await expect(
          verifyRuntimeSandboxAccount(stripe, { account: "acct_expected" }),
        ).rejects.toThrow(scenario === "foreign" ? "differs" : "test mode");
      expect(calls.map((call) => call.method)).toEqual(
        scenario === "foreign" ? ["GET"] : ["GET", "GET"],
      );
      expect(calls.every((call) => call.account === "acct_expected")).toBe(true);
    });
});
