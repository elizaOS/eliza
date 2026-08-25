// Exercises the live-Stripe-key deployment guard (#13752) with deterministic env fixtures.
import { afterEach, describe, expect, it } from "bun:test";
import {
  isLiveStripeSecretKey,
  shouldBlockLiveStripeKeyOutsideProduction,
  shouldWarnTestStripeKeyInProduction,
} from "./config/deployment-environment";
import { runWithCloudBindings } from "./runtime/cloud-bindings";
import { __resetStripeForTests, getStripe, isStripeConfigured } from "./stripe";

/**
 * #13752: the staging Worker was bound to prod's sk_live_ key, so add-funds on
 * staging created cs_live checkout sessions — hands-on QA could pay real money
 * into the staging DB. These tests pin the fail-closed guard: live keys are
 * rejected outside production; test keys in prod warn (non-fatal).
 *
 * Worker secrets are injected via runWithCloudBindings (same path the cloud
 * API uses per-request), so process.env stays untouched.
 */

// Built via concatenation so GitHub push protection / secret scanners do not
// flag these obviously-fake fixtures as real Stripe keys.
const LIVE_KEY = ["sk", "live", "FakeKeyForGuardTests000000"].join("_");
const TEST_KEY = ["sk", "test", "FakeKeyForGuardTests000000"].join("_");
const RESTRICTED_LIVE_KEY = ["rk", "live", "FakeKeyForGuardTests000000"].join("_");
const RESTRICTED_TEST_KEY = ["rk", "test", "FakeKeyForGuardTests000000"].join("_");
const CLOUD_E2E_TEST_KEY = ["sk", "test", "cloud", "e2e"].join("_");

afterEach(() => {
  __resetStripeForTests();
});

describe("isLiveStripeSecretKey", () => {
  it("detects live secret and restricted keys", () => {
    expect(isLiveStripeSecretKey(LIVE_KEY)).toBe(true);
    expect(isLiveStripeSecretKey("rk_live_abc")).toBe(true);
    expect(isLiveStripeSecretKey(`  ${LIVE_KEY}  `)).toBe(true);
  });

  it("does not flag test keys, empty, or unset", () => {
    expect(isLiveStripeSecretKey(TEST_KEY)).toBe(false);
    expect(isLiveStripeSecretKey("rk_test_abc")).toBe(false);
    expect(isLiveStripeSecretKey("")).toBe(false);
    expect(isLiveStripeSecretKey(undefined)).toBe(false);
  });
});

describe("shouldBlockLiveStripeKeyOutsideProduction", () => {
  it("blocks live keys in staging / preview / dev / test", () => {
    expect(
      shouldBlockLiveStripeKeyOutsideProduction({
        STRIPE_SECRET_KEY: LIVE_KEY,
        ENVIRONMENT: "staging",
      }),
    ).toBe(true);
    expect(
      shouldBlockLiveStripeKeyOutsideProduction({
        STRIPE_SECRET_KEY: LIVE_KEY,
        NODE_ENV: "test",
      }),
    ).toBe(true);
    expect(shouldBlockLiveStripeKeyOutsideProduction({ STRIPE_SECRET_KEY: LIVE_KEY })).toBe(true);
  });

  it("allows live keys in production (ENVIRONMENT or NODE_ENV)", () => {
    expect(
      shouldBlockLiveStripeKeyOutsideProduction({
        STRIPE_SECRET_KEY: LIVE_KEY,
        ENVIRONMENT: "production",
      }),
    ).toBe(false);
    expect(
      shouldBlockLiveStripeKeyOutsideProduction({
        STRIPE_SECRET_KEY: LIVE_KEY,
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("never blocks test keys or unset keys anywhere", () => {
    expect(
      shouldBlockLiveStripeKeyOutsideProduction({
        STRIPE_SECRET_KEY: TEST_KEY,
        ENVIRONMENT: "staging",
      }),
    ).toBe(false);
    expect(shouldBlockLiveStripeKeyOutsideProduction({ ENVIRONMENT: "staging" })).toBe(false);
  });

  it("honors ENVIRONMENT over NODE_ENV (staging worker with NODE_ENV=production still blocks)", () => {
    expect(
      shouldBlockLiveStripeKeyOutsideProduction({
        STRIPE_SECRET_KEY: LIVE_KEY,
        ENVIRONMENT: "staging",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });
});

describe("shouldWarnTestStripeKeyInProduction", () => {
  it("warns only for test keys in production", () => {
    expect(
      shouldWarnTestStripeKeyInProduction({
        STRIPE_SECRET_KEY: TEST_KEY,
        ENVIRONMENT: "production",
      }),
    ).toBe(true);
    expect(
      shouldWarnTestStripeKeyInProduction({
        STRIPE_SECRET_KEY: RESTRICTED_TEST_KEY,
        ENVIRONMENT: "production",
      }),
    ).toBe(true);
    expect(
      shouldWarnTestStripeKeyInProduction({
        STRIPE_SECRET_KEY: TEST_KEY,
        ENVIRONMENT: "staging",
      }),
    ).toBe(false);
    expect(
      shouldWarnTestStripeKeyInProduction({
        STRIPE_SECRET_KEY: LIVE_KEY,
        ENVIRONMENT: "production",
      }),
    ).toBe(false);
    expect(shouldWarnTestStripeKeyInProduction({ ENVIRONMENT: "production" })).toBe(false);
  });
});

describe("stripe client init guard (via Worker bindings)", () => {
  it("staging + sk_live_ fails closed: getStripe throws, isStripeConfigured is false", () => {
    runWithCloudBindings({ STRIPE_SECRET_KEY: LIVE_KEY, ENVIRONMENT: "staging" }, () => {
      expect(isStripeConfigured()).toBe(false);
      expect(() => getStripe()).toThrow(/LIVE-mode key .* not production/);
    });
  });

  it("staging + sk_test_ initializes normally", () => {
    runWithCloudBindings({ STRIPE_SECRET_KEY: TEST_KEY, ENVIRONMENT: "staging" }, () => {
      expect(isStripeConfigured()).toBe(true);
      expect(() => getStripe()).not.toThrow();
    });
  });

  it("production + sk_live_ initializes normally", () => {
    runWithCloudBindings({ STRIPE_SECRET_KEY: LIVE_KEY, ENVIRONMENT: "production" }, () => {
      expect(isStripeConfigured()).toBe(true);
      expect(() => getStripe()).not.toThrow();
    });
  });

  it("production + sk_test_ initializes (warn-only, not fatal)", () => {
    runWithCloudBindings({ STRIPE_SECRET_KEY: TEST_KEY, ENVIRONMENT: "production" }, () => {
      expect(isStripeConfigured()).toBe(true);
      expect(() => getStripe()).not.toThrow();
    });
  });

  it("production + rk_test_ initializes under the same test-key policy", () => {
    runWithCloudBindings(
      { STRIPE_SECRET_KEY: RESTRICTED_TEST_KEY, ENVIRONMENT: "production" },
      () => {
        expect(isStripeConfigured()).toBe(true);
        expect(() => getStripe()).not.toThrow();
      },
    );
  });

  it("does not reuse a cached production live client under a later staging live binding", () => {
    runWithCloudBindings({ STRIPE_SECRET_KEY: LIVE_KEY, ENVIRONMENT: "production" }, () => {
      expect(isStripeConfigured()).toBe(true);
      expect(() => getStripe()).not.toThrow();
    });

    runWithCloudBindings({ STRIPE_SECRET_KEY: LIVE_KEY, ENVIRONMENT: "staging" }, () => {
      expect(isStripeConfigured()).toBe(false);
      expect(() => getStripe()).toThrow(/LIVE-mode key .* not production/);
    });
  });

  it("does not reuse a cached staging test client under a later staging live binding", () => {
    runWithCloudBindings({ STRIPE_SECRET_KEY: TEST_KEY, ENVIRONMENT: "staging" }, () => {
      expect(isStripeConfigured()).toBe(true);
      expect(() => getStripe()).not.toThrow();
    });

    runWithCloudBindings({ STRIPE_SECRET_KEY: LIVE_KEY, ENVIRONMENT: "staging" }, () => {
      expect(isStripeConfigured()).toBe(false);
      expect(() => getStripe()).toThrow(/LIVE-mode key .* not production/);
    });
  });

  it("recovers when a later binding is valid after an earlier binding failed closed", () => {
    runWithCloudBindings({ STRIPE_SECRET_KEY: LIVE_KEY, ENVIRONMENT: "staging" }, () => {
      expect(isStripeConfigured()).toBe(false);
      expect(() => getStripe()).toThrow(/LIVE-mode key .* not production/);
    });

    runWithCloudBindings({ STRIPE_SECRET_KEY: TEST_KEY, ENVIRONMENT: "staging" }, () => {
      expect(isStripeConfigured()).toBe(true);
      expect(() => getStripe()).not.toThrow();
    });
  });

  it("restricted live keys fail through the live-key guard outside production", () => {
    runWithCloudBindings({ STRIPE_SECRET_KEY: RESTRICTED_LIVE_KEY, ENVIRONMENT: "staging" }, () => {
      expect(isStripeConfigured()).toBe(false);
      expect(() => getStripe()).toThrow(/LIVE-mode key .* not production/);
    });
  });

  it("routes the exact Cloud E2E sentinel client to a canonical loopback origin", () => {
    runWithCloudBindings(
      {
        STRIPE_SECRET_KEY: CLOUD_E2E_TEST_KEY,
        STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:43123",
        CLOUD_E2E: "1",
        NODE_ENV: "test",
        ENVIRONMENT: "local",
      },
      () => {
        expect(isStripeConfigured()).toBe(true);
        const stripe = getStripe();
        expect(stripe.getApiField("host")).toBe("127.0.0.1");
        expect(stripe.getApiField("port")).toBe("43123");
        expect(stripe.getApiField("protocol")).toBe("http");
        expect(stripe.getApiField("maxNetworkRetries")).toBe(0);
      },
    );
  });

  for (const [name, bindings] of [
    [
      "CLOUD_E2E is absent",
      {
        NODE_ENV: "test",
        ENVIRONMENT: "local",
      },
    ],
    [
      "NODE_ENV is not test",
      {
        CLOUD_E2E: "1",
        NODE_ENV: "development",
        ENVIRONMENT: "local",
      },
    ],
    [
      "ENVIRONMENT is not local",
      {
        CLOUD_E2E: "1",
        NODE_ENV: "test",
        ENVIRONMENT: "staging",
      },
    ],
  ] as const) {
    it(`rejects a Cloud E2E Stripe origin when ${name}`, () => {
      runWithCloudBindings(
        {
          STRIPE_SECRET_KEY: CLOUD_E2E_TEST_KEY,
          STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:43123",
          ...bindings,
        },
        () => {
          expect(isStripeConfigured()).toBe(false);
          expect(() => getStripe()).toThrow(/allowed only .* CLOUD_E2E test runtime/);
        },
      );
    });
  }

  for (const origin of [
    "https://127.0.0.1:43123",
    "http://localhost:43123",
    "http://127.0.0.1:43123/v1",
    "http://127.0.0.1:43123?redirect=1",
    "http://127.0.0.1:43123#fragment",
    "http://user:pass@127.0.0.1:43123",
    "http://127.0.0.1",
    "not-a-url",
  ]) {
    it(`rejects the non-canonical Cloud E2E Stripe origin ${origin}`, () => {
      runWithCloudBindings(
        {
          STRIPE_SECRET_KEY: CLOUD_E2E_TEST_KEY,
          STRIPE_CLOUD_E2E_API_ORIGIN: origin,
          CLOUD_E2E: "1",
          NODE_ENV: "test",
          ENVIRONMENT: "local",
        },
        () => {
          expect(isStripeConfigured()).toBe(false);
          expect(() => getStripe()).toThrow(/loopback origin|127\.0\.0\.1/);
        },
      );
    });
  }

  it("rejects a real-looking test key with the Cloud E2E origin override", () => {
    runWithCloudBindings(
      {
        STRIPE_SECRET_KEY: TEST_KEY,
        STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:43123",
        CLOUD_E2E: "1",
        NODE_ENV: "test",
        ENVIRONMENT: "local",
      },
      () => {
        expect(isStripeConfigured()).toBe(false);
        expect(() => getStripe()).toThrow(/synthetic test key/);
      },
    );
  });

  it("rejects the synthetic Cloud E2E key when its loopback origin is absent", () => {
    runWithCloudBindings(
      {
        STRIPE_SECRET_KEY: CLOUD_E2E_TEST_KEY,
        CLOUD_E2E: "1",
        NODE_ENV: "test",
        ENVIRONMENT: "local",
      },
      () => {
        expect(isStripeConfigured()).toBe(false);
        expect(() => getStripe()).toThrow(/requires its canonical loopback endpoint/);
      },
    );
  });

  it("does not reuse a cached Cloud E2E client after its gate is removed", () => {
    runWithCloudBindings(
      {
        STRIPE_SECRET_KEY: CLOUD_E2E_TEST_KEY,
        STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:43123",
        CLOUD_E2E: "1",
        NODE_ENV: "test",
        ENVIRONMENT: "local",
      },
      () => expect(() => getStripe()).not.toThrow(),
    );

    runWithCloudBindings(
      {
        STRIPE_SECRET_KEY: CLOUD_E2E_TEST_KEY,
        STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:43123",
        NODE_ENV: "test",
        ENVIRONMENT: "local",
      },
      () => {
        expect(isStripeConfigured()).toBe(false);
        expect(() => getStripe()).toThrow(/allowed only .* CLOUD_E2E test runtime/);
      },
    );
  });

  it("rebuilds the cached Cloud E2E client when the loopback origin changes", () => {
    let first: ReturnType<typeof getStripe> | undefined;
    runWithCloudBindings(
      {
        STRIPE_SECRET_KEY: CLOUD_E2E_TEST_KEY,
        STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:43123",
        CLOUD_E2E: "1",
        NODE_ENV: "test",
        ENVIRONMENT: "local",
      },
      () => {
        first = getStripe();
        expect(first.getApiField("port")).toBe("43123");
      },
    );

    runWithCloudBindings(
      {
        STRIPE_SECRET_KEY: CLOUD_E2E_TEST_KEY,
        STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:43124",
        CLOUD_E2E: "1",
        NODE_ENV: "test",
        ENVIRONMENT: "local",
      },
      () => {
        const second = getStripe();
        expect(second).not.toBe(first);
        expect(second.getApiField("port")).toBe("43124");
      },
    );
  });
});
