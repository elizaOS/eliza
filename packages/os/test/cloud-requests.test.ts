// spec/os/signIn/cloudRequests.md, "Story: Reach my account's cloud services without holding my key"; spec/os/signIn/cloudRequests.md, "Story: Let my agent read my mail without holding a mail credential"
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
      brokerReadWithoutLease: '403 {"reason":"mail-lease-upgrade-required"}',
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
      brokerReadForOwner: '200 {"accounts":[]}',
      brokerReadForAnotherOwner: '403 {"reason":"sign-in-required"}',
      brokerBearers: "lease",
      mailAfterRevokedLease: "SIGN_IN_REQUIRED",
      bearers: "lease/key,key",
      leaseReuses: 0,
      replyFromPreviousEnrollment: "SIGN_IN_REQUIRED",
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

describe("Let my agent read my mail without holding a mail credential", () => {
  it("forwards only the launch owner's Gmail account list and search from a private, current bearer, and says why anything else read nothing (spec/os/signIn/cloudRequests.md, \"The agent reaches the broker only by a bodiless GET on the loopback host, without an origin, with the current launch's bearer\"; spec/os/signIn/cloudRequests.md, \"The broker forwards only the owner's Gmail account list and search, with the lease, while the launch's owner holds it\"; spec/os/signIn/cloudRequests.md, \"The agent gets the cloud's status and body, or a refusal naming why nothing was read, and never the credential that read it\"; spec/os/agentService/config.md, \"Only a cloud launch is handed the mail broker, by its address and a bearer for that launch, never a credential\")", () => {
    const main = "ai.eliza.plugins.signin.GoogleBrokerJourney";
    const seen = JSON.parse(execFileSync(javaTool("java"), ["-cp", compileAdapter(main), main], { encoding: "utf8", timeout: 120_000 })) as Record<string, string>;
    const notBrokered = '404 {"reason":"not-brokered"}';
    const notPrivate = '403 {"reason":"not-private"}';
    const notAuthorized = '401 {"reason":"not-authorized"}';
    const signIn = '403 {"reason":"sign-in-required"}';
    expect(seen).toEqual({
      accounts: '200 {"accounts":[]}',
      search: '200 {"accounts":[]}',
      messageRead: notBrokered,
      unlistedField: notBrokered,
      calendarFeed: notBrokered,
      outsideThePrefix: notBrokered,
      post: notPrivate,
      withBody: notPrivate,
      withOrigin: notPrivate,
      headTooLarge: '431 {"reason":"request-too-large"}',
      withoutBearer: notAuthorized,
      wrongBearer: notAuthorized,
      samePortForNextLaunch: "true",
      previousLaunchBearer: notAuthorized,
      currentLaunchBearer: '200 {"accounts":[]}',
      anotherOwnerSignedIn: signIn,
      signedOut: signIn,
      ownerWithoutLease: '403 {"reason":"mail-lease-upgrade-required"}',
      leaseOfAnotherAccount: signIn,
      custodyFailed: '503 {"reason":"cloud-unreachable"}',
      reported: "the secure store could not be read",
      withoutLease: '403 {"reason":"mail-lease-upgrade-required"}',
      ownerChangedInFlight: signIn,
      offline: '503 {"reason":"cloud-unreachable"}',
      oversize: '502 {"reason":"reply-too-large"}',
      cloudRefusal: '401 {"error":"authentication_required","reason":"credential_revoked"}',
      handedToOwnKeyLaunch: "null",
      cloudBearerAfterOwnKeyLaunch: notAuthorized,
      spawnFailedBearer: notAuthorized,
      exitedLaunchBearer: notAuthorized,
      relaunchAfterEarlierServiceEnded: '200 {"accounts":[]}',
      endedServiceOpens: "null",
      beyondCapacityClosedAtOnce: "true",
      idleClosedAtDeadline: "true",
      readAfterIdle: '200 {"accounts":[]}',
      relaunchAskedOfTheHolder: "1 true",
      replacedServesItsLaunch: '200 {"accounts":[]}',
      replacedClosedOnceRevoked: "closed",
      closedBrokerOpens: "The mail broker was closed and opens for no launch",
      closedBrokerHandedToALaunch: "null [Closed]",
      nextLaunchReadsThroughReplacement: '200 {"accounts":[]}',
      queuedClosedWithAnUnheldReplacedBroker: "true",
      relaunchesAsked: "1",
      unclosed: "",
      forwarded: [
        "/api/v1/eliza/google/accounts?side=owner as owner",
        "/api/v1/eliza/google/gmail/search?side=owner&grantId=g1&query=in%3Ainbox&maxResults=25 as owner",
        ...Array.from({ length: 10 }, () => "/api/v1/eliza/google/accounts?side=owner as owner"),
      ].join(","),
    });
  });
});
