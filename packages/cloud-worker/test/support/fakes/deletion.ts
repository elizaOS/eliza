// spec/cloud/identity/deletion.md, "Each provider call of a step is one receipt of that step's kind, owned by the account, under a provider key never used before"
import type { FakeServer } from "../fakes.ts";
import { createCipheriv, randomBytes } from "node:crypto";
import { googleFakeState, mountGoogleToken, seedGrant, type GoogleFakeState } from "./google.ts";
import { createStripeFake, type StripeFake, type StripeSubscriptionStatus } from "./stripe.ts";
import { withSubscriptionLifecycle, type Subscribed } from "./stripe-subscriptions.ts";

export interface DeletionProviders {
  readonly stripe: StripeFake;
  readonly google: GoogleFakeState;
  mount(fakes: FakeServer): void;
  subscribe(priceId: string): Subscribed;
  grant(subject: string): string;
  loseNextCancelReply(subscriptionId: string): void;
  revealCanceled(subscriptionId: string): void;
  loseNextRevokeReply(refreshToken: string): void;
  subscriptionStatus(subscriptionId: string): StripeSubscriptionStatus;
  revoked(refreshToken: string): boolean;
  revokeCalls(): number;
  cancelCalls(fakes: FakeServer, subscriptionId: string): number;
}

export function deletionProviders(now?: () => number): DeletionProviders {
  const lifecycle = withSubscriptionLifecycle(createStripeFake(now === undefined ? {} : { now }));
  const google = googleFakeState();
  const lost = new Set<string>();
  const hidden = new Set<string>();
  const droppedGoogle = new Set<string>();
  const stripe: StripeFake = { ...lifecycle.stripe, handler: (request) => {
    const path = request.path;
    if (request.method === "GET" && hidden.has(path)) return { status: 503, body: { error: { type: "api_error" } } };
    const answer = lifecycle.stripe.handler(request);
    if (request.method !== "DELETE" || !lost.delete(path)) return answer;
    hidden.add(path);
    return { status: 504, body: { error: { type: "api_error" } } };
  } };
  return {
    stripe,
    google,
    mount: (fakes) => {
      const handle = mountGoogleToken(google);
      fakes.mount("/google/", (request) => {
        if (request.path === "/revoke") {
          const token = new URLSearchParams(request.body).get("token") ?? "";
          if (droppedGoogle.delete(token)) google.switches.dropNextChangeReply = true;
        }
        return handle(request);
      });
    },
    subscribe: (priceId) => lifecycle.subscribe(priceId),
    grant: (subject) => seedGrant(google, { subject, email: `${subject}@example.com`, scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"] }),
    loseNextCancelReply: (subscriptionId) => { lost.add(`/v1/subscriptions/${subscriptionId}`); },
    revealCanceled: (subscriptionId) => { hidden.delete(`/v1/subscriptions/${subscriptionId}`); },
    loseNextRevokeReply: (refreshToken) => { droppedGoogle.add(refreshToken); },
    subscriptionStatus: (subscriptionId) => (stripe.object(subscriptionId) as { readonly status: StripeSubscriptionStatus }).status,
    revoked: (refreshToken) => google.revoked.has(refreshToken),
    revokeCalls: () => google.calls.filter((call) => call.method === "POST" && call.path === "/revoke").length,
    cancelCalls: (fakes, subscriptionId) => fakes.seen.filter((seen) => seen.method === "DELETE" && seen.path === `/stripe/v1/subscriptions/${subscriptionId}`).length,
  };
}

export function workerRefreshCipher(key: string, origin: string, userId: string, subject: string, refreshToken: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(["cloud-google-token-v1", origin, userId, subject, true, false, "send_mail"])));
  return Buffer.concat([nonce, cipher.update(refreshToken), cipher.final(), cipher.getAuthTag()]).toString("hex");
}
