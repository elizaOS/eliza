/**
 * Remote-host credential parsing contract: the revocable bearer credential is
 * accepted only when the host id is a canonical pairing UUID and the token is
 * exactly the versioned 43-character alphabet; every other presentation fails
 * closed to null so the route can 401 instead of trusting a malformed header.
 */

import { describe, expect, test } from "bun:test";

import { parseRemoteHostCredential } from "./host-auth";

const HOST_ID = "11111111-1111-4111-8111-111111111111";

function requestWith(header: {
  hostId?: string;
  authorization?: string;
}): Request {
  const headers = new Headers();
  if (header.hostId !== undefined) {
    headers.set("x-remote-host-id", header.hostId);
  }
  if (header.authorization !== undefined) {
    headers.set("authorization", header.authorization);
  }
  return new Request("https://api.example.com/remote", { headers });
}

// Exactly 43 alphabet chars after the versioned prefix, per the credential regex.
const VALID_TOKEN = "rhost_v1_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
// Token suffix exercising every character class of the credential alphabet
// ([A-Za-z0-9_-]{43}): uppercase, lowercase, digits, `_`, and `-`.
const MIXED_TOKEN = "rhost_v1_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcde";

describe("parseRemoteHostCredential", () => {
  test("accepts a canonical UUID host id with a well-formed versioned token", () => {
    const credential = parseRemoteHostCredential(
      requestWith({
        hostId: HOST_ID,
        authorization: `Bearer ${VALID_TOKEN}`,
      }),
    );
    expect(credential).toEqual({ hostId: HOST_ID, token: VALID_TOKEN });
  });

  test("accepts a token suffix that exercises every alphabet class (digits, _, -)", () => {
    const credential = parseRemoteHostCredential(
      requestWith({
        hostId: HOST_ID,
        authorization: `Bearer ${MIXED_TOKEN}`,
      }),
    );
    expect(credential).toEqual({ hostId: HOST_ID, token: MIXED_TOKEN });
  });

  test("trims surrounding whitespace from the host id header", () => {
    const credential = parseRemoteHostCredential(
      requestWith({
        hostId: `  ${HOST_ID}  `,
        authorization: `Bearer ${VALID_TOKEN}`,
      }),
    );
    expect(credential).toEqual({ hostId: HOST_ID, token: VALID_TOKEN });
  });

  test("rejects a missing host id", () => {
    expect(
      parseRemoteHostCredential(
        requestWith({ authorization: `Bearer ${VALID_TOKEN}` }),
      ),
    ).toBeNull();
  });

  test("rejects a non-UUID host id", () => {
    expect(
      parseRemoteHostCredential(
        requestWith({
          hostId: "not-a-uuid",
          authorization: `Bearer ${VALID_TOKEN}`,
        }),
      ),
    ).toBeNull();
  });

  test("rejects a missing authorization header", () => {
    expect(
      parseRemoteHostCredential(requestWith({ hostId: HOST_ID })),
    ).toBeNull();
  });

  test("rejects a non-Bearer scheme", () => {
    expect(
      parseRemoteHostCredential(
        requestWith({
          hostId: HOST_ID,
          authorization: `Basic ${VALID_TOKEN}`,
        }),
      ),
    ).toBeNull();
  });

  test("rejects an unversioned token prefix", () => {
    expect(
      parseRemoteHostCredential(
        requestWith({
          hostId: HOST_ID,
          authorization: `Bearer ${VALID_TOKEN.slice("rhost_v1_".length)}`,
        }),
      ),
    ).toBeNull();
  });

  test("rejects a token that is too short", () => {
    expect(
      parseRemoteHostCredential(
        requestWith({
          hostId: HOST_ID,
          authorization: `Bearer ${VALID_TOKEN.slice(0, -1)}`,
        }),
      ),
    ).toBeNull();
  });

  test("rejects a token that is too long", () => {
    expect(
      parseRemoteHostCredential(
        requestWith({
          hostId: HOST_ID,
          authorization: `Bearer ${VALID_TOKEN}x`,
        }),
      ),
    ).toBeNull();
  });

  test("rejects a token containing characters outside the alphabet", () => {
    expect(
      parseRemoteHostCredential(
        requestWith({
          hostId: HOST_ID,
          authorization: `Bearer ${VALID_TOKEN.slice(0, -1)}.`,
        }),
      ),
    ).toBeNull();
  });
});
