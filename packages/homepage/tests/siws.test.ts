/**
 * Unit coverage for the SIWS client's pure base58 encoding, outgoing request
 * construction, relying-party parsing guards, verification cross-checks, and
 * wallet detection paths that the HTTP boundary suite does not exercise.
 * Drives the real signInWithSolana and bs58Encode against deterministic
 * fetch/wallet doubles; no network access occurs.
 */
import { afterEach, describe, expect, test } from "vitest";
import { getElizacloudUrl } from "../src/lib/api/client";
import { bs58Encode, signInWithSolana } from "../src/lib/api/siws";

const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "fetch",
);
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
const originalTimeoutDescriptor = Object.getOwnPropertyDescriptor(
  AbortSignal,
  "timeout",
);

const SIGNER_ADDRESS = "11111111111111111111111111111111";
const OTHER_ADDRESS = "22222222222222222222222222222222";

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
  address: SIGNER_ADDRESS,
  isNewAccount: false,
  user: {
    id: "user-1",
    wallet_address: SIGNER_ADDRESS,
    organization_id: "org-1",
  },
  organization: { id: "org-1", name: "Org", slug: "org" },
};

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

type RecordedCall = { url: string; init: RequestInit };

function installBrowserDoubles(
  respond: (
    callIndex: number,
    url: string,
    init: RequestInit,
  ) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    writable: true,
    value: () => nativeTimeout(50),
  });
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: RecordedCall = { url: input.toString(), init: init ?? {} };
    calls.push(call);
    return respond(calls.length, call.url, call.init);
  }) as typeof fetch;
  return calls;
}

function browserWindow(
  extra: Record<string, unknown>,
): Window & typeof globalThis {
  return {
    location: { origin: "https://eliza.app", hostname: "eliza.app" },
    ...extra,
  } as unknown as Window & typeof globalThis;
}

function installTestSigner(): void {
  globalThis.window = browserWindow({
    __siwsTestSigner: {
      publicKey: SIGNER_ADDRESS,
      sign: () => new Uint8Array(64).fill(1),
    },
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
});

async function runHappyPath(
  overrides: {
    nonce?: Record<string, unknown>;
    verified?: Record<string, unknown>;
  } = {},
): Promise<RecordedCall[]> {
  let request = 0;
  const nonceValue = { ...nonce, ...overrides.nonce };
  const verifiedValue = { ...verified, ...overrides.verified };
  const calls = installBrowserDoubles(() => {
    request += 1;
    return jsonResponse(request === 1 ? nonceValue : verifiedValue);
  });
  await expect(signInWithSolana()).resolves.toEqual(verifiedValue);
  return calls;
}

describe("bs58Encode", () => {
  test("encodes an empty byte array to an empty string", () => {
    expect(bs58Encode(new Uint8Array(0))).toBe("");
  });

  test("prepends one leading 1 for each leading zero byte", () => {
    expect(bs58Encode(new Uint8Array([0]))).toBe("1");
    expect(bs58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
  });

  test("matches independently computed reference vectors", () => {
    expect(bs58Encode(new TextEncoder().encode("hello world"))).toBe(
      "StV1DL6CwTryKyV",
    );
    expect(bs58Encode(new Uint8Array([255, 254, 253]))).toBe("2UzCt");
  });

  test("encodes 64-byte signature payloads to stable base58 strings", () => {
    expect(bs58Encode(new Uint8Array(64).fill(1))).toBe(
      "2AXDGYSE4f2sz7tvMMzyHvUfcoJmxudvdhBcmiUSo6ijwfYmfZYsKRxboQMPh3R4kUhXRVdtSXFXMheka4Rc4P2",
    );
    expect(bs58Encode(new Uint8Array(64).fill(255))).toBe(
      "67rpwLCuS5DGA8KGZXKsVQ7dnPb9goRLoKfgGbLfQg9WoLUgNY77E2jT11fem3coV9nAkguBACzrU1iyZM4B8roQ",
    );
  });
});

describe("SIWS outgoing requests", () => {
  test("requests the nonce endpoint for mainnet with a JSON accept header", async () => {
    let request = 0;
    const calls = installBrowserDoubles((_index, _url, _init) => {
      request += 1;
      return jsonResponse(request === 1 ? nonce : verified);
    });
    installTestSigner();

    await expect(signInWithSolana()).resolves.toEqual(verified);

    expect(request).toBe(2);
    expect(calls[0].url).toBe(
      `${getElizacloudUrl()}/api/auth/siws/nonce?chainId=solana:mainnet`,
    );
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).Accept).toBe(
      "application/json",
    );
  });

  test("posts the signed SIWS message and base58 signature to the verification endpoint", async () => {
    let request = 0;
    const calls = installBrowserDoubles((_index, _url, _init) => {
      request += 1;
      return jsonResponse(request === 1 ? nonce : verified);
    });
    installTestSigner();

    await expect(signInWithSolana()).resolves.toEqual(verified);

    expect(calls[1].url).toBe(`${getElizacloudUrl()}/api/auth/siws/verify`);
    expect(calls[1].init.method).toBe("POST");
    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");

    const body = JSON.parse(String(calls[1].init.body)) as {
      message: string;
      signature: string;
    };
    expect(body.signature).toBe(bs58Encode(new Uint8Array(64).fill(1)));
    expect(body.signature).toBe(
      "2AXDGYSE4f2sz7tvMMzyHvUfcoJmxudvdhBcmiUSo6ijwfYmfZYsKRxboQMPh3R4kUhXRVdtSXFXMheka4Rc4P2",
    );

    const expectedPrefix = `${nonce.domain} wants you to sign in with your Solana account:
${SIGNER_ADDRESS}

${nonce.statement}

URI: ${nonce.uri}
Version: ${nonce.version}
Chain ID: ${nonce.chainId}
Nonce: ${nonce.nonce}
Issued At: `;
    expect(body.message.startsWith(expectedPrefix)).toBe(true);
    const issuedAt = body.message.slice(expectedPrefix.length);
    expect(issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(issuedAt))).toBe(false);
  });
});

describe("SIWS relying-party validation", () => {
  test("accepts loopback relying parties served over plain http", async () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      installTestSigner();
      await runHappyPath({
        nonce: { domain: host, uri: `http://${host}` },
      });
    }
  });

  test("rejects plain-http relying parties outside the loopback", async () => {
    installBrowserDoubles(() =>
      jsonResponse({ ...nonce, uri: "http://eliza.app" }),
    );
    installTestSigner();

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );
  });

  test("rejects relying-party URIs that carry credentials", async () => {
    installBrowserDoubles(() =>
      jsonResponse({
        ...nonce,
        uri: "https://user:secret@eliza.app",
      }),
    );
    installTestSigner();

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );
  });

  test("rejects relying-party URIs that carry a fragment", async () => {
    installBrowserDoubles(() =>
      jsonResponse({ ...nonce, uri: "https://eliza.app#extra" }),
    );
    installTestSigner();

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );
  });
});

describe("SIWS nonce schema guards", () => {
  test("rejects chain ids and versions outside the mainnet v1 contract", async () => {
    for (const override of [{ chainId: "solana:devnet" }, { version: "2" }]) {
      installBrowserDoubles(() => jsonResponse({ ...nonce, ...override }));
      installTestSigner();
      await expect(signInWithSolana()).rejects.toThrow(
        "SIWS nonce response has an invalid shape",
      );
    }
  });

  test("enforces the statement byte budget at its exact boundary", async () => {
    installBrowserDoubles(() =>
      jsonResponse({ ...nonce, statement: "a".repeat(513) }),
    );
    installTestSigner();
    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );

    await runHappyPath({ nonce: { statement: "a".repeat(512) } });
  });

  test("rejects statements containing line breaks", async () => {
    installBrowserDoubles(() =>
      jsonResponse({ ...nonce, statement: "Sign in\rto Eliza\nnow" }),
    );
    installTestSigner();
    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS nonce response has an invalid shape",
    );
  });
});

describe("SIWS verification cross-checks", () => {
  test("rejects a verified address that differs from the signer", async () => {
    installBrowserDoubles(async (_index, _url, _init) =>
      jsonResponse(
        _index === 1
          ? nonce
          : {
              ...verified,
              address: OTHER_ADDRESS,
              user: { ...verified.user, wallet_address: OTHER_ADDRESS },
            },
      ),
    );
    installTestSigner();

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS verification response does not match the signer",
    );
  });

  test("rejects when the canonical wallet address disagrees with the signer", async () => {
    installBrowserDoubles(async (_index, _url, _init) =>
      jsonResponse(
        _index === 1
          ? nonce
          : {
              ...verified,
              user: { ...verified.user, wallet_address: OTHER_ADDRESS },
            },
      ),
    );
    installTestSigner();

    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS verification response does not match the signer",
    );
  });

  test("enforces the API key byte budget at its exact boundary", async () => {
    installTestSigner();
    await runHappyPath({ verified: { apiKey: "k".repeat(8192) } });

    installBrowserDoubles(async (_index, _url, _init) =>
      jsonResponse(
        _index === 1 ? nonce : { ...verified, apiKey: "k".repeat(8193) },
      ),
    );
    installTestSigner();
    await expect(signInWithSolana()).rejects.toThrow(
      "SIWS verification response has an invalid shape",
    );
  });
});

describe("SIWS wallet detection", () => {
  test("explains when neither a wallet nor a test signer is available", async () => {
    installBrowserDoubles(() => jsonResponse(nonce));
    globalThis.window = browserWindow({});

    await expect(signInWithSolana()).rejects.toThrow(
      "No Solana wallet detected. Install Phantom from phantom.app to continue.",
    );
  });

  test("signs directly with an already-connected Phantom wallet", async () => {
    let connectCalls = 0;
    installBrowserDoubles(async (_index, _url, _init) =>
      jsonResponse(_index === 1 ? nonce : verified),
    );
    globalThis.window = browserWindow({
      solana: {
        publicKey: { toString: () => SIGNER_ADDRESS },
        connect: () => {
          connectCalls += 1;
          return Promise.resolve(undefined);
        },
        signMessage: async () => ({ signature: new Uint8Array(64).fill(2) }),
      },
    });

    await expect(signInWithSolana()).resolves.toEqual(verified);
    expect(connectCalls).toBe(0);
  });

  test("uses a nested phantom.solana wallet when window.solana is absent", async () => {
    installBrowserDoubles(async (_index, _url, _init) =>
      jsonResponse(_index === 1 ? nonce : verified),
    );
    globalThis.window = browserWindow({
      phantom: {
        solana: {
          publicKey: { toString: () => SIGNER_ADDRESS },
          connect: () => Promise.resolve(undefined),
          signMessage: async () => ({
            signature: new Uint8Array(64).fill(3),
          }),
        },
      },
    });

    await expect(signInWithSolana()).resolves.toEqual(verified);
  });

  test("connects a locked Phantom wallet before requesting the nonce", async () => {
    let request = 0;
    installBrowserDoubles(async (_index, _url, _init) => {
      request += 1;
      return jsonResponse(request === 1 ? nonce : verified);
    });
    globalThis.window = browserWindow({
      solana: {
        connect: () =>
          Promise.resolve({ publicKey: { toString: () => SIGNER_ADDRESS } }),
        signMessage: async () => ({ signature: new Uint8Array(64).fill(4) }),
      },
    });

    await expect(signInWithSolana()).resolves.toEqual(verified);
    expect(request).toBe(2);
  });

  test("reports a rejected wallet connection", async () => {
    installBrowserDoubles(() => jsonResponse(nonce));
    globalThis.window = browserWindow({
      solana: {
        connect: () => Promise.resolve(undefined),
        signMessage: async () => ({ signature: new Uint8Array(64) }),
      },
    });

    await expect(signInWithSolana()).rejects.toThrow(
      "Wallet connection rejected",
    );
  });
});
