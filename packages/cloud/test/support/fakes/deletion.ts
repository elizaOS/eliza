// spec/cloud/identity/deletion.md, "Each provider call of a step is one receipt of that step's kind, owned by the account, under a provider key never used before"
import type { FakeServer } from "../fakes.ts";
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
  loseNextRevokeReply(): void;
  subscriptionStatus(subscriptionId: string): StripeSubscriptionStatus;
  revoked(refreshToken: string): boolean;
  revokeCalls(): number;
  cancelCalls(fakes: FakeServer, subscriptionId: string): number;
}

export function deletionProviders(now?: () => number): DeletionProviders {
  const lifecycle = withSubscriptionLifecycle(createStripeFake(now === undefined ? {} : { now }));
  const google = googleFakeState();
  const stripe = lifecycle.stripe;
  return {
    stripe,
    google,
    mount: (fakes) => fakes.mount("/google/", mountGoogleToken(google)),
    subscribe: (priceId) => lifecycle.subscribe(priceId),
    grant: (subject) => seedGrant(google, { subject, email: `${subject}@example.com`, scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"] }),
    loseNextCancelReply: (subscriptionId) => stripe.dropNextReply(`/v1/subscriptions/${subscriptionId}`),
    loseNextRevokeReply: () => {
      google.switches.dropNextReply = true;
    },
    subscriptionStatus: (subscriptionId) => (stripe.object(subscriptionId) as { readonly status: StripeSubscriptionStatus }).status,
    revoked: (refreshToken) => google.revoked.has(refreshToken),
    revokeCalls: () => google.calls.filter((call) => call.method === "POST" && call.path === "/revoke").length,
    cancelCalls: (fakes, subscriptionId) => fakes.seen.filter((seen) => seen.method === "DELETE" && seen.path === `/stripe/v1/subscriptions/${subscriptionId}`).length,
  };
}
