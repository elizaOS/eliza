import {
  ChallengeStore,
  MemoryBackend,
  NamespacedStoreBackend,
  type StoreBackend,
} from "../../auth/index";

export const WALLET_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
export const SOCIAL_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
export const OAUTH_LINK_CHALLENGE_TTL_MS = 5 * 60_000;
const initialUserLinkBackend = new MemoryBackend();
let currentUserLinkBackend: StoreBackend | null = null;
export let walletLinkChallenges: ChallengeStore;
export let socialLinkChallenges: ChallengeStore;
export let oauthLinkChallenges: ChallengeStore;

/** Bind account-link challenges to auth startup's selected durable backend. */
export function initUserLinkChallengeStores(backend: StoreBackend): void {
  const supersededBackend = currentUserLinkBackend;
  currentUserLinkBackend = backend;
  walletLinkChallenges = new ChallengeStore({
    backend: new NamespacedStoreBackend(backend, "user-link-wallet"),
    ttlMs: WALLET_LINK_CHALLENGE_TTL_MS,
  });
  socialLinkChallenges = new ChallengeStore({
    backend: new NamespacedStoreBackend(backend, "user-link-social"),
    ttlMs: SOCIAL_LINK_CHALLENGE_TTL_MS,
  });
  oauthLinkChallenges = new ChallengeStore({
    backend: new NamespacedStoreBackend(backend, "user-link-oauth"),
    ttlMs: OAUTH_LINK_CHALLENGE_TTL_MS,
  });
  if (
    supersededBackend instanceof MemoryBackend &&
    supersededBackend !== backend
  ) {
    supersededBackend.destroy();
  }
}

// Development and tests remain process-local until auth startup selects the
// shared backend. Every entry is still bounded by the flow-specific TTL.
initUserLinkChallengeStores(initialUserLinkBackend);
