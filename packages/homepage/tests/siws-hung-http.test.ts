/**
 * SIWS tests exercise both response-consumption boundaries with deterministic fetch and signer doubles.
 * Global browser primitives are restored explicitly so this suite cannot change later tests in Bun's process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { signInWithSolana } from "../src/lib/api/siws";
import {
  assertCanonicalSiwsIdentity,
  confirmSiwsSession,
} from "../src/lib/context/siws-session";

const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
const originalTimeoutDescriptor = Object.getOwnPropertyDescriptor(
  AbortSignal,
  "timeout",
);
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "fetch",
);
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

const nonce = {
  nonce: "0123456789abcdef0123456789abcdef",
  domain: "eliza.app",
  uri: "https://eliza.app",
  chainId: "solana:mainnet",
  version: "1",
  statement: "Sign in to Eliza",
};

const verified = {
  apiKey: "session-token",
  address: "11111111111111111111111111111111",
  isNewAccount: false,
  user: {
    id: "user-1",
    wallet_address: "11111111111111111111111111111111",
    organization_id: "org-1",
  },
  organization: { id: "org-1", name: "Org", slug: "org" },
};

function installBrowserDoubles(fetchImpl: typeof fetch): void {
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    writable: true,
    value: () => nativeTimeout(5),
  });
  globalThis.fetch = fetchImpl;
  globalThis.window = {
    location: {
      origin: "https://eliza.app",
      hostname: "eliza.app",
    },
    __siwsTestSigner: {
      publicKey: "11111111111111111111111111111111",
      sign: () => new Uint8Array(64).fill(1),
    },
  } as unknown as Window & typeof globalThis;
}

function stalledJsonResponse(cancel?: () => void | Promise<void>): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {}, cancel }), {
    headers: { "Content-Type": "application/json" },
  });
}

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}

afterEach(() => {
  restoreProperty(globalThis, "fetch", originalFetchDescriptor);
  restoreProperty(globalThis, "window", originalWindowDescriptor);
  restoreProperty(AbortSignal, "timeout", originalTimeoutDescriptor);
  expect(Object.getOwnPropertyDescriptor(AbortSignal, "timeout")).toEqual(
    originalTimeoutDescriptor,
  );
});

describe("SIWS HTTP boundary", () => {
  test("does not publish a candidate bearer while canonical loading is pending", async () => {
    let visibleToken = "prior-token";
    let resolveCanonical!: (value: typeof verified) => void;
    const canonical = new Promise<typeof verified>((resolve) => {
      resolveCanonical = resolve;
    });

    const confirmation = confirmSiwsSession("issued-token", {
      loadCanonicalUser: async () => canonical,
      validateCanonicalUser: (value) => {
        expect(value.user.id).toBe("user-1");
      },
      commitSession: (token) => {
        visibleToken = token;
      },
    });

    await Promise.resolve();
    expect(visibleToken).toBe("prior-token");
    resolveCanonical(verified);
    await confirmation;
    expect(visibleToken).toBe("issued-token");
  });

  test("preserves a prior session when canonical loading fails", async () => {
    let visibleToken = "prior-token";
    let commits = 0;
    const failure = new Error("canonical session rejected");

    await expect(
      confirmSiwsSession("issued-token", {
        loadCanonicalUser: async () => {
          throw failure;
        },
        validateCanonicalUser: () => {
          throw new Error("validation must not run");
        },
        commitSession: (token) => {
          visibleToken = token;
          commits += 1;
        },
      }),
    ).rejects.toBe(failure);
    expect(visibleToken).toBe("prior-token");
    expect(commits).toBe(0);
  });

  test("preserves a prior session when canonical identity validation fails", async () => {
    let visibleToken = "prior-token";
    let commits = 0;
    const mismatched = {
      user: { id: "other-user", organization_id: "org-1" },
      organization: { id: "org-1" },
    };

    await expect(
      confirmSiwsSession("issued-token", {
        loadCanonicalUser: async () => mismatched,
        validateCanonicalUser: (value) => {
          assertCanonicalSiwsIdentity(verified, value);
        },
        commitSession: (token) => {
          visibleToken = token;
          commits += 1;
        },
      }),
    ).rejects.toThrow("Canonical SIWS identity does not match verification");
    expect(visibleToken).toBe("prior-token");
    expect(commits).toBe(0);
  });

  test("times out while consuming the nonce response body", async () => {
    let cancelled = false;
    installBrowserDoubles(async () =>
      stalledJsonResponse(() => {
        cancelled = true;
      }),
    );

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce request timed out",
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("uses a fresh timeout and times out while consuming the verification body", async () => {
    const signals: AbortSignal[] = [];
    let request = 0;
    installBrowserDoubles(async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      request += 1;
      return request === 1 ? jsonResponse(nonce) : stalledJsonResponse();
    });

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS verification request timed out",
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  test("accepts the canonical Cloud relying party from the marketing origin", async () => {
    // Production shape: the page is served from eliza.app while the Cloud API
    // issues its own NEXT_PUBLIC_APP_URL origin as the SIWS relying party.
    const cloudNonce = {
      ...nonce,
      domain: "cloud.eliza.app",
      uri: "https://cloud.eliza.app",
    };
    let request = 0;
    installBrowserDoubles(async () => {
      request += 1;
      return jsonResponse(request === 1 ? cloudNonce : verified);
    });

    await expect(signInWithSolana()).resolves.toEqual(verified);
  });

  test("rejects redirects and accepts valid response shapes", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    let request = 0;
    installBrowserDoubles(async (_input, init) => {
      redirects.push(init?.redirect);
      request += 1;
      return jsonResponse(request === 1 ? nonce : verified);
    });

    await expect(signInWithSolana()).resolves.toEqual(verified);
    expect(redirects).toEqual(["error", "error"]);
  });

  test("does not expose an error response body", async () => {
    let cancelled = false;
    installBrowserDoubles(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"private":"server-secret"}'),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
    );

    await expect(signInWithSolana()).rejects.toThrow(
      /^SIWS nonce request failed \(401\)$/,
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("rejects a streamed response that exceeds the byte limit", async () => {
    let cancelAttempted = false;
    installBrowserDoubles(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024 + 1));
            },
            cancel() {
              cancelAttempted = true;
              return new Promise<void>(() => {});
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce request returned an invalid response",
    );
    expect(cancelAttempted).toBe(true);
  });

  test("rejects JSON-looking but non-JSON media types", async () => {
    let cancelled = false;
    installBrowserDoubles(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(nonce)),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/jsonp" } },
        ),
    );

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce request returned an invalid response",
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("rejects declared oversized bodies before reading and cancels them", async () => {
    let cancelled = false;
    installBrowserDoubles(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(64 * 1024 + 1),
            },
          },
        ),
    );

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce request returned an invalid response",
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("rejects a redirected response even when a fetch double ignores redirect:error", async () => {
    const response = jsonResponse(nonce);
    Object.defineProperties(response, {
      redirected: { configurable: true, value: true },
      url: { configurable: true, value: "https://attacker.invalid/nonce" },
    });
    installBrowserDoubles(async () => response);

    await expect(signInWithSolana()).rejects.toThrow(
      /^SIWS nonce request failed$/,
    );
    expect(response.bodyUsed).toBe(true);
  });

  test("rejects invalid nonce and verification schemas", async () => {
    installBrowserDoubles(async () => jsonResponse({ nonce: "nonce-1" }));
    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );

    let request = 0;
    installBrowserDoubles(async () => {
      request += 1;
      return jsonResponse(request === 1 ? nonce : { apiKey: "session-token" });
    });
    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS verification response has an invalid shape",
    );
  });

  test("rejects injected or inconsistent nonce fields before wallet signing", async () => {
    let signed = false;
    installBrowserDoubles(async () =>
      jsonResponse({
        ...nonce,
        domain: "eliza.app\nURI: https://attacker.invalid",
      }),
    );
    window.__siwsTestSigner = {
      publicKey: verified.address,
      sign: () => {
        signed = true;
        return new Uint8Array(64);
      },
    };
    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );

    installBrowserDoubles(async () =>
      jsonResponse({
        ...nonce,
        domain: "attacker.invalid",
        uri: "https://attacker.invalid",
      }),
    );
    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );
    expect(signed).toBe(false);

    installBrowserDoubles(async () =>
      jsonResponse({ ...nonce, uri: "https://different.eliza.app" }),
    );
    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );
  });

  test("rejects verification identities that disagree about organization authority", async () => {
    let request = 0;
    installBrowserDoubles(async () => {
      request += 1;
      return jsonResponse(
        request === 1
          ? nonce
          : {
              ...verified,
              organization: { ...verified.organization, id: "other-org" },
            },
      );
    });

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS verification response has an invalid shape",
    );
  });

  test("rejects missing organizations and control characters in identity fields", async () => {
    const invalidResponses = [
      { ...verified, organization: null },
      { ...verified, user: { ...verified.user, id: "user-1\nadmin" } },
      {
        ...verified,
        user: { ...verified.user, organization_id: "org-1\tother" },
      },
      {
        ...verified,
        organization: { ...verified.organization, id: "org-1\u007f" },
      },
      {
        ...verified,
        organization: { ...verified.organization, slug: "org\radmin" },
      },
    ];

    for (const invalid of invalidResponses) {
      let request = 0;
      installBrowserDoubles(async () => {
        request += 1;
        return jsonResponse(request === 1 ? nonce : invalid);
      });
      await expect(signInWithSolana()).rejects.toThrow(
        "SIWS verification response has an invalid shape",
      );
    }
  });

  test("rejects malformed wallet outputs before verification", async () => {
    installBrowserDoubles(async () => jsonResponse(nonce));
    window.__siwsTestSigner = {
      publicKey: "not-a-solana-address",
      sign: () => new Uint8Array(64),
    };
    await expect(signInWithSolana()).rejects.toThrow(
      "Wallet returned an invalid Solana address",
    );

    installBrowserDoubles(async () => jsonResponse(nonce));
    window.__siwsTestSigner = {
      publicKey: verified.address,
      sign: () => new Uint8Array(63),
    };
    await expect(signInWithSolana()).rejects.toThrow(
      "Wallet returned an invalid Solana signature",
    );
  });
});
