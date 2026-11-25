// spec/os/signIn/cloudRequests.md, "Story: Reach my account's cloud services without holding my key"; spec/os/signIn/cloudRequests.md, "A call tied to a device credential cannot use a different credential"
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as client from "../gen/cloud__client.ts";
import * as spec from "../gen/os__signIn__cloudRequests.ts";
import { compileAdapter } from "./drivers/jvm-adapter.ts";
import { expectCasesAgree, javaTool, type Case } from "./support/law-cases.ts";

interface Origins { readonly fn: "originOf"; readonly accepted: Readonly<Record<string, boolean>> }

function javaLines(): { readonly cases: Case[]; readonly origins: Origins } {
  const main = "ai.eliza.plugins.signin.CloudRequestLawCheck";
  const out = execFileSync(javaTool("java"), ["-cp", compileAdapter(main), main], { encoding: "utf8", maxBuffer: 1 << 29 });
  const lines = out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Case | Origins);
  const origins = lines.find((line): line is Origins => line.fn === "originOf");
  if (origins === undefined) throw new Error("the law check printed no originOf line");
  return { cases: lines.filter((line): line is Case => line.fn !== "originOf"), origins };
}

const functions = { ...client, ...spec } as unknown as Record<string, unknown>;

function expected(c: Case): unknown {
  const value = functions[c.fn];
  return typeof value === "function" ? (value as (...args: readonly unknown[]) => unknown)(...c.args) : value;
}

describe("Reach my account's cloud services without holding my key", () => {
  const { cases, origins } = javaLines();

  it("admits, attaches, reports and hands off as the generated spec does over every value the spec names", () => {
    const names = new Set(cases.map((c) => c.fn));
    expect(cases.length).toBeGreaterThan(5000);
    expect([...names].filter((name) => functions[name] === undefined)).toEqual([]);
    expectCasesAgree(cases, expected);
  });

  it("refuses a table with a sign-in, streamed or unlisted route whole and admits only listed calls from the wire", () => {
    const accepted = cases.filter((c) => c.fn === "cloudTableAccepted").map((c) => c.result);
    expect(accepted.slice(-5)).toEqual([true, false, false, false, false]);
    const sent = cases.filter((c) => c.fn === "planRequest" && (c.result as { tag: string }).tag === "Send");
    expect(sent.length).toBeGreaterThan(0);
    for (const c of sent) expect(c.args[4]).not.toContain("Authorization");
  });

  it("asks a device with an old key to sign in once and sends mail only with the lease after a lost rotation reply", () => {
    const main = "ai.eliza.plugins.signin.DeviceKeyJourney";
    const seen = JSON.parse(execFileSync(javaTool("java"), ["-cp", compileAdapter(main), main, "cloud"], { encoding: "utf8", timeout: 120_000 })) as unknown;
    expect(seen).toEqual({
      mailSignedOut: "SIGN_IN_REQUIRED",
      keyOnlySignIn: "SIGNED_IN",
      mailWithoutLease: "MAIL_LEASE_UPGRADE_REQUIRED",
      settledRequestCancelled: false,
      oldKeyAfterCancel: true,
      mailAfterCancel: "MAIL_LEASE_UPGRADE_REQUIRED",
      inferenceBeforeUpgrade: "200",
      upgradeWithoutLease: "SUPERSEDED",
      upgradeToOtherOrganization: "SUPERSEDED",
      refusalsKeptOldKey: true,
      restartRetiredPendingUpgrade: true,
      failedUpgradeAcknowledgements: 0,
      leasedSignIn: "SIGNED_IN",
      upgradeStayedWithOwner: true,
      mailAfterLostRotation: "NETWORK",
      mailWithStaleAuthority: "SIGN_IN_REQUIRED",
      mailWithUnknownQuery: "NOT_LISTED",
      mailWithLease: "200",
      inferenceWithKey: "200",
      mailAfterRevokedLease: "SIGN_IN_REQUIRED",
      bearers: "lease/key,key",
      leaseReuses: 0,
      replyFromPreviousEnrollment: "SIGN_IN_REQUIRED",
      boundPreviousCredential: "SIGN_IN_REQUIRED",
      boundCurrentCredential: "200",
      boundCannotUseLease: "SIGN_IN_REQUIRED",
      boundReachedOnlyReviewedKey: true,
      sameOwnerReEnrolledAtNewVersion: true,
      legacyVaultBindingMatches: true,
      replyFromBeforeRenewal: "SIGN_IN_REQUIRED",
      sameOwnerRenewedAtNewVersion: true,
      readAfterRenewal: "200",
      vaultBindingAfterRenewalRestart: true,
      refreshFromPreviousEnrollment: true,
    });
  });

  it("sends only to an https origin, or http on loopback, with no path, user, query or fragment", () => {
    expect(origins.accepted).toEqual({
      "https://api.cloud.test": true,
      "https://api.cloud.test/": false,
      "https://api.cloud.test/v1": false,
      "http://127.0.0.1:8080": true,
      "http://api.cloud.test": false,
      "https://user@api.cloud.test": false,
      "https://api.cloud.test?x=1": false,
      "ftp://api.cloud.test": false,
      "not a url": false,
    });
  });
});
