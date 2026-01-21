/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-rss.
 * DO NOT EDIT - Generated from prompts/specs/**.
 */

export type ActionDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  parameters?: readonly unknown[];
  examples?: readonly (readonly unknown[])[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  position?: number;
  dynamic?: boolean;
};

export type EvaluatorDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  alwaysRun?: boolean;
  examples?: readonly unknown[];
};

export const coreActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "GET_NEWSFEED",
      description: "Download and parse an RSS/Atom feed from a URL",
      similes: ["FETCH_RSS", "READ_FEED", "DOWNLOAD_FEED"],
      parameters: [],
    },
    {
      name: "LIST_RSS_FEEDS",
      description: "List all subscribed RSS/Atom feeds",
      similes: ["SHOW_RSS_FEEDS", "GET_RSS_FEEDS", "RSS_SUBSCRIPTIONS"],
      parameters: [],
    },
    {
      name: "SUBSCRIBE_RSS_FEED",
      description: "Subscribe to an RSS/Atom feed for automatic monitoring",
      similes: ["ADD_RSS_FEED", "FOLLOW_RSS_FEED", "SUBSCRIBE_TO_RSS"],
      parameters: [],
    },
    {
      name: "UNSUBSCRIBE_RSS_FEED",
      description: "Unsubscribe from an RSS/Atom feed",
      similes: ["REMOVE_RSS_FEED", "UNFOLLOW_RSS_FEED", "DELETE_RSS_FEED"],
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "GET_NEWSFEED",
      description: "Download and parse an RSS/Atom feed from a URL",
      similes: ["FETCH_RSS", "READ_FEED", "DOWNLOAD_FEED"],
      parameters: [],
    },
    {
      name: "LIST_RSS_FEEDS",
      description: "List all subscribed RSS/Atom feeds",
      similes: ["SHOW_RSS_FEEDS", "GET_RSS_FEEDS", "RSS_SUBSCRIPTIONS"],
      parameters: [],
    },
    {
      name: "SUBSCRIBE_RSS_FEED",
      description: "Subscribe to an RSS/Atom feed for automatic monitoring",
      similes: ["ADD_RSS_FEED", "FOLLOW_RSS_FEED", "SUBSCRIBE_TO_RSS"],
      parameters: [],
    },
    {
      name: "UNSUBSCRIBE_RSS_FEED",
      description: "Unsubscribe from an RSS/Atom feed",
      similes: ["REMOVE_RSS_FEED", "UNFOLLOW_RSS_FEED", "DELETE_RSS_FEED"],
      parameters: [],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "FEEDITEMS",
      description: "Provides recent news and articles from subscribed RSS feeds",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "FEEDITEMS",
      description: "Provides recent news and articles from subscribed RSS feeds",
      dynamic: true,
    },
  ],
} as const;
export const coreEvaluatorsSpec = {
  version: "1.0.0",
  evaluators: [],
} as const;
export const allEvaluatorsSpec = {
  version: "1.0.0",
  evaluators: [],
} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] = coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] = allEvaluatorsSpec.evaluators;
