/**
 * Connector target catalog — surfaces the user's enabled connectors as
 * structured `TargetGroup`s so the workflow clarification UI can render
 * quick-pick servers, channels, recipients, and chats without making the
 * end-user paste raw IDs.
 *
 * The catalog holds no per-connector logic: it drains the runtime's registered
 * `TargetSource`s (each contributed by its owning connector plugin, e.g.
 * plugin-discord) and forwards the host config accessor + injectable
 * `fetch` / clock. A new connector adds a source in its own plugin — no route,
 * UI, or app-core edit. When no source is registered for a platform, the route
 * falls back to a free-text input.
 */

import type {
  TargetEnumerationContext,
  TargetGroup,
  TargetSource,
  TargetSourceLogger,
} from "@elizaos/core";

export type { TargetEntry, TargetGroup } from "@elizaos/core";

export interface ListGroupsOptions {
  /** Restrict to a single platform (e.g. only Discord). */
  platform?: string;
  /** Restrict to a single group within the platform (e.g. one guild). */
  groupId?: string;
}

export interface ConnectorTargetCatalog {
  listGroups(opts?: ListGroupsOptions): Promise<TargetGroup[]>;
  /**
   * No-op lifecycle hook so the runtime service-stop loop (core/runtime.ts)
   * does not warn "Service instance is missing stop(); skipping" on every
   * restart. The catalog holds no own resources — each registered source owns
   * its own REST cache.
   */
  stop(): Promise<void>;
}

export interface ElizaConnectorTargetCatalogOptions {
  /** Drains the runtime's registered target sources on every call. */
  listSources: () => TargetSource[];
  /** Host connector config accessor, forwarded to each source. */
  getConfig: () => unknown;
  /** Test injection seam — sources default to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test injection seam — sources default to Date.now. */
  now?: () => number;
  /** Optional logger; warnings only. */
  logger?: TargetSourceLogger;
}

export function createElizaConnectorTargetCatalog(
  options: ElizaConnectorTargetCatalogOptions,
): ConnectorTargetCatalog {
  return {
    async listGroups(opts: ListGroupsOptions = {}): Promise<TargetGroup[]> {
      const ctx: TargetEnumerationContext = {
        groupId: opts.groupId,
        getConfig: options.getConfig,
        fetchImpl: options.fetchImpl,
        now: options.now,
        logger: options.logger,
      };

      const all: TargetGroup[] = [];
      for (const source of options.listSources()) {
        if (opts.platform && source.platform !== opts.platform) continue;
        for (const group of await source.enumerate(ctx)) all.push(group);
      }
      return all;
    },
    async stop(): Promise<void> {
      // No own resources; each registered source owns its cache.
    },
  };
}
