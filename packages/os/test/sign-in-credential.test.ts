// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"; spec/os/signIn/credential.md, "Only the lease renews the key, and a renewed key keeps the account and the lease"; spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileAdapter } from "./drivers/jvm-adapter.ts";

const main = "ai.eliza.plugins.signin.DeviceKeyJourney";
const javaTool = (name: string) => process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/${name}` : name;

let walked: Readonly<Record<string, unknown>> | undefined;

function journey(): Readonly<Record<string, unknown>> {
  walked ??= JSON.parse(execFileSync(javaTool("java"), ["-cp", compileAdapter(main), main], { encoding: "utf8", timeout: 120_000 })) as Record<string, unknown>;
  return walked;
}

const account = { userId: "user-1", organizationId: "org-1" };
const announce = (version: number) => ({ tag: "Announce", version, account });

describe("Keep me signed in without a second copy of my key", () => {
  it("keeps a minted key after a lost token reply asked again with the same code and verifier, and announces each new key once", () => {
    const seen = journey();
    expect([seen.firstSignIn, seen.firstHeld, seen.lostReplyAskedAgainWithSameProof, seen.keyHiddenFromText]).toEqual(["SIGNED_IN", "1/cred-2/user-1", true, true]);
    expect([seen.secondSignIn, seen.secondHeld, seen.owedAfterReplace, seen.revokedAfterReplace]).toEqual(["SIGNED_IN", "2/cred-4/user-1", 1, "cred-2"]);
    expect(seen.unprefixedSlots).toBe(0);
  });

  it("keeps the account on an expired key and signs out only when the account read finds the key revoked", () => {
    const seen = journey();
    expect(seen.afterRevokedElsewhere).toBe("none");
    expect(seen.afterExpired).toBe("none/user-1");
    expect(seen.dutiesAfterCloudEnded).toBe(0);
    expect(seen.notices).toEqual([announce(1), announce(2), { tag: "SignedOutNotice" }, announce(3), { tag: "VerifyAccount" }, { tag: "SignedOutNotice" },
      announce(4), { tag: "ExpiredNotice" }, announce(5)]);
  });

  it("rotates the lease silently after a lost reply and renews the key through it once half its life is gone", () => {
    const seen = journey();
    expect([seen.leasedSignIn, seen.lostRotation, seen.rotatedAfterLostReply, seen.rotationsAsked, seen.leaseReuses]).toEqual(["SIGNED_IN", "null", true, 3, 0]);
    expect([seen.renewedAtHalfLife, seen.oldLeaseReadEnded, seen.owedAfterRenewal, seen.replacedKeyEnded, seen.leaseKeptByRenewal]).toEqual(["7/cred-13/user-1", true, true, true, true]);
    expect(seen.leaseNotices).toEqual([announce(6), announce(7), announce(8), announce(9), { tag: "SignedOutNotice" }]);
  });

  it("asks a renewal's lost acknowledgement again instead of stranding or signing out, and ends a lease refresh a renewal overtook", () => {
    const seen = journey();
    expect([seen.lostRenewalAckAskedAgain, seen.rotationAfterRenewalAck]).toEqual(["8/cred-14/user-1", "true/REFUSED/true"]);
  });
});

describe("Sign out or reset cleanly", () => {
  it("stores the revoke duty with the sign-out, asks three times offline and once more at the next start", () => {
    const seen = journey();
    expect([seen.dutyStoredWithSignOut, seen.offlineRevokeAsks, seen.dutiesKeptOffline]).toEqual([true, 3, 1]);
    expect([seen.triesAtStart, seen.onlineRevokeAsks, seen.revokedAfterStart, seen.dutiesAfterStart, seen.alreadyRevoked]).toEqual([1, 1, "cred-2,cred-4", 0, true]);
  });

  it("signs out completely when the cloud revokes the lease, owing the key and leaving no key or lease slot", () => {
    const seen = journey();
    expect([seen.accessAfterRevokedLease, seen.afterRevokedLease, seen.owedAfterRevokedLease]).toEqual(["null", "none", true]);
    expect([seen.keyRevokedAfterLease, seen.slotsAfterLeaseSignOut]).toEqual([true, 0]);
  });
});

describe("Confirm it is me before a billing change", () => {
  it("holds a session only for the signed-in account, shares one refresh among readers and ends it after the hour", () => {
    const seen = journey();
    expect([seen.otherAccountRefused, seen.sessionGranted, seen.usableToken]).toEqual([true, true, "access-1"]);
    expect([seen.refreshesForFourReaders, seen.tokensAfterRefresh, seen.afterTheHour]).toEqual([1, "access-2,access-2,access-2,access-2", "null"]);
  });
});

it('Complete an ordinary browser sign-in once across recreation without adopting a stale or reauthentication return (spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it")', () => {
  const output = execFileSync(javaTool("java"), ["-cp", compileAdapter(main), main, "browser"], { encoding: "utf8", timeout: 120_000 });
  expect(JSON.parse(output)).toEqual({ adopted: true, oneUse: true, isolated: true, drift: true, reauthClosed: true, keptAccount: true });
});
