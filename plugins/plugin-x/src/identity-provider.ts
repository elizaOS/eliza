/**
 * X (Twitter) identity provider.
 *
 * Makes the agent aware of its own X account: `@username`, screen name
 * (the human-readable display name), bio/description, and any configured
 * nicknames. Without this provider the agent only had a vague sense of its
 * handle (via the `{{twitterUserName}}` template variable) and no awareness of
 * its bio, display name, or nicknames at all.
 *
 * Reads the already-loaded profile from `XService.getActiveProfile()`; it never
 * triggers a network call and returns empty context when the X client has not
 * finished authenticating.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { TwitterProfile } from "./base";
import type { XService } from "./services/x.service";

// Matches `XService.serviceType`. Kept as a local literal so this provider can
// be imported (and unit-tested) without loading the heavy XService module and
// its transitive Twitter API client dependencies.
const X_SERVICE_TYPE = "x";

function renderIdentityText(profile: TwitterProfile): string {
  const lines = [
    `The agent's X (Twitter) account:`,
    `- Username: @${profile.username}`,
    `- Screen name: ${profile.screenName}`,
  ];
  if (profile.bio.trim()) {
    lines.push(`- Bio: ${profile.bio.trim()}`);
  }
  if (profile.nicknames.length > 0) {
    lines.push(`- Nicknames: ${profile.nicknames.join(", ")}`);
  }
  return lines.join("\n");
}

export const xIdentityProvider: Provider = {
  name: "TWITTER_IDENTITY",
  description:
    "The agent's own X (Twitter) identity: username, screen name, bio, and nicknames.",
  position: -10,
  dynamic: true,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<XService>(X_SERVICE_TYPE);
    const profile = service?.getActiveProfile() ?? null;

    if (!profile) {
      return {
        text: "",
        values: {},
        data: { twitterProfile: null },
      };
    }

    return {
      text: renderIdentityText(profile),
      values: {
        twitterUserName: profile.username,
        twitterScreenName: profile.screenName,
        twitterBio: profile.bio,
        twitterNicknames: profile.nicknames.join(", "),
      },
      data: {
        twitterProfile: {
          id: profile.id,
          username: profile.username,
          screenName: profile.screenName,
          bio: profile.bio,
          nicknames: profile.nicknames,
        },
      },
    };
  },
};
