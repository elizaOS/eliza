/**
 * `hasSsoDomainVerificationTxt` collapsed every `resolveTxt` rejection into
 * `false`, and the SSO verify route renders `false` as
 * `409 Missing DNS TXT record _steward-sso.<domain>`. A resolver timeout or a
 * SERVFAIL therefore told the tenant admin that a record they had already
 * published was missing — the only visible remedy being to re-publish a
 * correct record. Only `ENOTFOUND` (no such name) and `ENODATA` (name exists,
 * empty RRset) actually prove the token is not published.
 */
import { expect, spyOn, test } from "bun:test";
import { promises as dns } from "node:dns";
import { hasSsoDomainVerificationTxt } from "../api/routes/tenant-config";

function dnsFailure(code: string) {
  return () =>
    Promise.reject(Object.assign(new Error(`queryTxt ${code}`), { code }));
}

test.each([["ETIMEOUT"], ["ESERVFAIL"], ["EAI_AGAIN"], ["ECONNREFUSED"]])(
  "a %s lookup failure is not reported as a missing TXT record",
  async (code) => {
    const lookup = spyOn(dns, "resolveTxt").mockImplementation(
      dnsFailure(code) as never,
    );
    try {
      await expect(
        hasSsoDomainVerificationTxt("acme.example.com", "token-1"),
      ).rejects.toThrow(`queryTxt ${code}`);
    } finally {
      lookup.mockRestore();
    }
  },
);

test.each([["ENOTFOUND"], ["ENODATA"]])(
  "a %s answer still means the record is missing",
  async (code) => {
    const lookup = spyOn(dns, "resolveTxt").mockImplementation(
      dnsFailure(code) as never,
    );
    try {
      expect(
        await hasSsoDomainVerificationTxt("acme.example.com", "token-1"),
      ).toBe(false);
    } finally {
      lookup.mockRestore();
    }
  },
);

test("a published matching token still verifies", async () => {
  const lookup = spyOn(dns, "resolveTxt").mockImplementation((() =>
    Promise.resolve([["token-1"]])) as never);
  try {
    expect(
      await hasSsoDomainVerificationTxt("acme.example.com", "token-1"),
    ).toBe(true);
  } finally {
    lookup.mockRestore();
  }
});

test("a published token from another tenant is still rejected", async () => {
  const lookup = spyOn(dns, "resolveTxt").mockImplementation((() =>
    Promise.resolve([["token-2"]])) as never);
  try {
    expect(
      await hasSsoDomainVerificationTxt("acme.example.com", "token-1"),
    ).toBe(false);
  } finally {
    lookup.mockRestore();
  }
});
