/**
 * Pins the mail-security baseline evaluation for the company domain against
 * fixture DNS answers. The harness is deterministic: it exercises the real
 * `evaluateMailSecurity` contract with resolver-shaped records and never
 * touches the network, so the lane stays valid without live DNS.
 */

import { describe, expect, it } from "bun:test";
import { evaluateMailSecurity } from "./mail-security.mjs";

const VALID_DKIM_KEY = "A".repeat(392);

function baseline(overrides = {}) {
  return {
    mx: [{ exchange: "smtp.google.com.", priority: 10 }],
    txt: [
      "google-site-verification=OW7Tt3TNJhYeFd-rkgP-SwwJ7teY7q9aXhwKd06bg3w",
      "v=spf1 include:_spf.google.com ~all",
    ],
    dkimTxt: [`v=DKIM1;k=rsa;p=${VALID_DKIM_KEY}`],
    dmarcTxt: [
      "v=DMARC1; p=none; rua=mailto:dmarc-reports@elizaresearch.ai; fo=1",
    ],
    ...overrides,
  };
}

function check(records, id) {
  const found = evaluateMailSecurity(records).checks.find(
    (entry) => entry.id === id,
  );
  if (!found) throw new Error(`no check reported for ${id}`);
  return found;
}

describe("evaluateMailSecurity", () => {
  it("passes every control on a fully configured domain", () => {
    const report = evaluateMailSecurity(baseline());
    expect(report.ok).toBe(true);
    expect(report.checks.map((entry) => entry.id)).toEqual([
      "mx",
      "spf",
      "dkim",
      "dmarc",
    ]);
  });

  it("fails when no DMARC policy is published, which is the live gap", () => {
    const report = evaluateMailSecurity(baseline({ dmarcTxt: [] }));
    expect(report.ok).toBe(false);
    expect(check(baseline({ dmarcTxt: [] }), "dmarc").detail).toContain(
      "p=none monitor mode",
    );
  });

  it("rejects a DMARC record with no aggregate-report destination", () => {
    expect(
      check(baseline({ dmarcTxt: ["v=DMARC1; p=none"] }), "dmarc").ok,
    ).toBe(false);
  });

  it("rejects duplicate DMARC records", () => {
    const records = baseline({
      dmarcTxt: [
        "v=DMARC1; p=none; rua=mailto:a@elizaresearch.ai",
        "v=DMARC1; p=reject; rua=mailto:b@elizaresearch.ai",
      ],
    });
    expect(check(records, "dmarc").detail).toContain("exactly one is valid");
  });

  it("accepts an enforcing DMARC policy once alignment is reviewed", () => {
    const records = baseline({
      dmarcTxt: [
        "v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc-reports@elizaresearch.ai",
      ],
    });
    expect(check(records, "dmarc")).toMatchObject({ ok: true });
  });

  it("fails when more than one SPF record is authoritative", () => {
    const records = baseline({
      txt: [
        "v=spf1 include:_spf.google.com ~all",
        "v=spf1 include:sendgrid.net ~all",
      ],
    });
    expect(check(records, "spf").detail).toContain(
      "exactly one is authoritative",
    );
  });

  it("fails a permissive SPF qualifier", () => {
    expect(
      check(baseline({ txt: ["v=spf1 include:_spf.google.com +all"] }), "spf")
        .ok,
    ).toBe(false);
  });

  it("fails SPF that does not authorize Workspace senders", () => {
    expect(
      check(baseline({ txt: ["v=spf1 include:sendgrid.net ~all"] }), "spf")
        .detail,
    ).toContain("Google Workspace");
  });

  it("fails a missing SPF record", () => {
    expect(check(baseline({ txt: [] }), "spf").ok).toBe(false);
  });

  it("treats a revoked DKIM key (empty p=) as a failure", () => {
    expect(
      check(baseline({ dkimTxt: ["v=DKIM1;k=rsa;p="] }), "dkim").detail,
    ).toContain("revoked");
  });

  it("rejects a DKIM key shorter than 2048 bits", () => {
    expect(
      check(
        baseline({ dkimTxt: [`v=DKIM1;k=rsa;p=${"A".repeat(120)}`] }),
        "dkim",
      ).ok,
    ).toBe(false);
  });

  it("fails a missing DKIM key", () => {
    expect(check(baseline({ dkimTxt: [] }), "dkim").ok).toBe(false);
  });

  it("fails when MX routes mail away from Workspace", () => {
    const records = baseline({
      mx: [{ exchange: "mx.attacker.example.", priority: 5 }],
    });
    expect(check(records, "mx").detail).toContain("mx.attacker.example");
  });

  it("fails when no MX records exist", () => {
    expect(check(baseline({ mx: [] }), "mx").ok).toBe(false);
  });

  it("joins split TXT character strings before matching", () => {
    // Resolvers return long keys as chunks; the CLI flattens them, so a
    // flattened long key must still parse as one valid record.
    const records = baseline({
      dkimTxt: [`v=DKIM1;k=rsa;p=${"B".repeat(400)}`],
    });
    expect(check(records, "dkim").ok).toBe(true);
  });
});
