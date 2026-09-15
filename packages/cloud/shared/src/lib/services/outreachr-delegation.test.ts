/** Exercises replay, registration, revocation, and fresh ownership at the delegated identity boundary. */
import { describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  OutreachrDelegationService,
  type OutreachrGrant,
  type OutreachrPrincipal,
} from "./outreachr-delegation";
import { validateOutreachrGoogleRequest } from "./outreachr-google-request";

function fixture() {
  const secret = "outreachr-test-client-secret-with-adequate-entropy";
  const registration = {
    appId: randomUUID(),
    origin: "https://outreachr.example.com",
    clientSecretSha256: createHash("sha256").update(secret).digest("hex"),
  };
  let now = 1000;
  let active = true;
  let deletionConfirmed = true;
  let user: OutreachrPrincipal | null = {
    id: randomUUID(),
    organizationId: randomUUID(),
    name: "Test",
    email: "test@example.com",
    emailVerified: true,
  };
  const codes = new Map<string, { appId: string; userId: string }>();
  const grants = new Map<string, OutreachrGrant>();
  const service = new OutreachrDelegationService({
    async verifyRegistration() {
      if (!active) throw new Error("App disabled");
    },
    async consumeCode(code) {
      const result = codes.get(code);
      codes.delete(code);
      return result ?? null;
    },
    async findPrincipal() {
      return user;
    },
    async saveGrant(key, grant) {
      if (grants.has(key)) return false;
      grants.set(key, grant);
      return true;
    },
    async readGrant(key) {
      return grants.get(key) ?? null;
    },
    async deleteGrant(key) {
      if (!deletionConfirmed) return false;
      grants.delete(key);
      return true;
    },
    now: () => now,
  });
  const issue = (appId = registration.appId) => {
    const code = `eac_${randomUUID()}`;
    codes.set(code, { appId, userId: user!.id });
    return code;
  };
  return {
    service,
    registration,
    secret,
    issue,
    grants,
    setNow: (value: number) => {
      now = value;
    },
    setUser: (value: OutreachrPrincipal | null) => {
      user = value;
    },
    getUser: () => user!,
    setActive: (value: boolean) => {
      active = value;
    },
    failDeletion: () => {
      deletionConfirmed = false;
    },
  };
}

describe("Outreachr delegation", () => {
  it("requires the registered client before consuming a code, and rejects code replay", async () => {
    const f = fixture();
    const code = f.issue();
    await expect(f.service.exchange(f.registration, "wrong", code)).rejects.toMatchObject({
      status: 401,
    });
    const session = await f.service.exchange(f.registration, f.secret, code);
    expect((await f.service.authorize(f.registration, f.secret, session.token)).id).toBe(
      f.getUser().id,
    );
    expect([...f.grants.keys()].join()).not.toContain(session.token);
    await expect(f.service.exchange(f.registration, f.secret, code)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("rejects codes for another app and unverified accounts", async () => {
    const f = fixture();
    await expect(
      f.service.exchange(f.registration, f.secret, f.issue(randomUUID())),
    ).rejects.toMatchObject({ status: 401 });
    f.setUser({ ...f.getUser(), emailVerified: false });
    await expect(f.service.exchange(f.registration, f.secret, f.issue())).rejects.toMatchObject({
      status: 403,
    });
  });
  it("revalidates primary account ownership and app activation on every use", async () => {
    const f = fixture();
    const { token } = await f.service.exchange(f.registration, f.secret, f.issue());
    const original = f.getUser();
    f.setUser({ ...original, organizationId: randomUUID() });
    await expect(f.service.authorize(f.registration, f.secret, token)).rejects.toMatchObject({
      status: 401,
    });
    f.setUser(null);
    await expect(f.service.authorize(f.registration, f.secret, token)).rejects.toMatchObject({
      status: 403,
    });
    f.setUser(original);
    f.setActive(false);
    await expect(f.service.authorize(f.registration, f.secret, token)).rejects.toThrow(
      "App disabled",
    );
  });
  it("expires grants at the exact boundary and invalidates them after client rotation", async () => {
    const f = fixture();
    const session = await f.service.exchange(f.registration, f.secret, f.issue());
    const rotated = "a-new-outreachr-client-secret-with-adequate-entropy";
    await expect(
      f.service.authorize(
        {
          ...f.registration,
          clientSecretSha256: createHash("sha256").update(rotated).digest("hex"),
        },
        rotated,
        session.token,
      ),
    ).rejects.toMatchObject({ status: 401 });
    f.setNow(Date.parse(session.expiresAt));
    await expect(
      f.service.authorize(f.registration, f.secret, session.token),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("confirms revocation and never reports a failed invalidation as successful", async () => {
    const f = fixture();
    const first = await f.service.exchange(f.registration, f.secret, f.issue());
    await f.service.revoke(f.registration, f.secret, first.token);
    await expect(f.service.authorize(f.registration, f.secret, first.token)).rejects.toMatchObject({
      status: 401,
    });
    const second = await f.service.exchange(f.registration, f.secret, f.issue());
    f.failDeletion();
    await expect(f.service.revoke(f.registration, f.secret, second.token)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("Outreachr Google transport", () => {
  it("allows paginated current-user mail and initial send operations", () => {
    const read = validateOutreachrGoogleRequest({
      method: "GET",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in%3Asent&pageToken=next",
    });
    expect(new URL(read.url).searchParams.get("pageToken")).toBe("next");
    expect(
      validateOutreachrGoogleRequest({
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        body: '{"raw":"message"}',
      }).method,
    ).toBe("POST");
  });
  it("rejects credential endpoints, another mailbox, deletion, token override, and attacker hosts", () => {
    for (const request of [
      { method: "POST", url: "https://oauth2.googleapis.com/token" },
      {
        method: "GET",
        url: "https://gmail.googleapis.com/gmail/v1/users/other@example.com/messages",
      },
      {
        method: "DELETE",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/message-id",
      },
      {
        method: "GET",
        url: "https://gmail.googleapis.com.attacker.com/gmail/v1/users/me/messages",
      },
      {
        method: "GET",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?access_token=override",
      },
      {
        method: "GET",
        url: "https://user:password@gmail.googleapis.com/gmail/v1/users/me/messages",
      },
      { method: "GET", url: "http://127.0.0.1/secrets" },
    ])
      expect(() => validateOutreachrGoogleRequest(request)).toThrow();
  });
});
