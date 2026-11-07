/**
 * Per-source failure isolation in TriageService.triage() / search().
 *
 * Regression: a single adapter throwing (e.g. the pre-implementation Discord
 * stub's NotYetImplementedError) aborted the entire cross-connector sweep,
 * so "triage my messages" died even when other connectors were healthy.
 * The service now degrades per-source and only rethrows when failures leave
 * zero results overall (a broken sweep must not masquerade as an empty inbox).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { searchMessagesAction } from "../actions/searchMessages.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { MessageRefStore } from "../message-ref-store.ts";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
  TriageService,
} from "../triage-service.ts";
import {
  type ListOptions,
  type MessageAdapterCapabilities,
  type MessageRef,
  type MessageSource,
  NotYetImplementedError,
  type SearchMessagesFilters,
} from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

function ref(source: MessageSource, id: string): MessageRef {
  return {
    id: `${source}:${id}`,
    source,
    externalId: id,
    from: { identifier: "someone@example.com" },
    to: [],
    snippet: `hello from ${source}`,
    receivedAtMs: Date.now(),
    hasAttachments: false,
    isRead: false,
  };
}

class HealthyAdapter extends BaseMessageAdapter {
  constructor(
    readonly source: MessageSource,
    private readonly refs: MessageRef[],
  ) {
    super();
  }
  isAvailable(): boolean {
    return true;
  }
  capabilities(): MessageAdapterCapabilities {
    return {
      list: true,
      search: false,
      manage: {},
      send: {},
      worlds: "single",
      channels: "none",
    };
  }
  protected listMessagesImpl(
    _runtime: IAgentRuntime,
    _opts: ListOptions,
  ): Promise<MessageRef[]> {
    return Promise.resolve(this.refs);
  }
}

/** Available but unimplemented — the exact shape of the old Discord stub. */
class ThrowingAdapter extends BaseMessageAdapter {
  constructor(readonly source: MessageSource) {
    super();
  }
  isAvailable(): boolean {
    return true;
  }
}

describe("TriageService per-source failure isolation", () => {
  it("triage() returns healthy-source results when another source throws", async () => {
    const service = new TriageService(new MessageRefStore());
    service.register(new HealthyAdapter("gmail", [ref("gmail", "g1")]));
    service.register(new ThrowingAdapter("discord"));

    const ranked = await service.triage(createFakeRuntime(), {
      sources: ["gmail", "discord"],
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0].source).toBe("gmail");
  });

  it("triage() rethrows when failures leave zero results", async () => {
    const service = new TriageService(new MessageRefStore());
    service.register(new ThrowingAdapter("discord"));

    await expect(
      service.triage(createFakeRuntime(), { sources: ["discord"] }),
    ).rejects.toBeInstanceOf(NotYetImplementedError);
  });

  it("triage() rethrows when the only failure hides behind an honest empty source", async () => {
    const service = new TriageService(new MessageRefStore());
    service.register(new HealthyAdapter("gmail", []));
    service.register(new ThrowingAdapter("discord"));

    await expect(
      service.triage(createFakeRuntime(), { sources: ["gmail", "discord"] }),
    ).rejects.toBeInstanceOf(NotYetImplementedError);
  });

  it("triage() with only empty healthy sources resolves to []", async () => {
    const service = new TriageService(new MessageRefStore());
    service.register(new HealthyAdapter("gmail", []));

    await expect(
      service.triage(createFakeRuntime(), { sources: ["gmail"] }),
    ).resolves.toEqual([]);
  });

  it("search() returns healthy-source hits when another source throws", async () => {
    const service = new TriageService(new MessageRefStore());
    service.register(new HealthyAdapter("gmail", [ref("gmail", "g2")]));
    service.register(new ThrowingAdapter("discord"));

    const hits = await service.search(createFakeRuntime(), {
      sources: ["gmail", "discord"],
      content: "hello",
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("gmail");
  });

  it("search() rethrows when failures leave zero hits", async () => {
    const service = new TriageService(new MessageRefStore());
    service.register(new ThrowingAdapter("discord"));

    await expect(
      service.search(createFakeRuntime(), {
        sources: ["discord"],
        content: "hello",
      }),
    ).rejects.toBeInstanceOf(NotYetImplementedError);
  });

  it("searchWithReceipt uses limit+1 to distinguish overflow from exact fit", async () => {
    const runtime = createFakeRuntime();
    const overflowService = new TriageService(new MessageRefStore());
    overflowService.register(
      new HealthyAdapter("gmail", [
        ref("gmail", "1"),
        ref("gmail", "2"),
        ref("gmail", "3"),
      ]),
    );
    const overflow = await overflowService.searchWithReceipt(runtime, {
      sources: ["gmail"],
      content: "hello",
      limit: 2,
    });
    expect(overflow.refs).toHaveLength(2);
    expect(overflow.receipt).toMatchObject({
      succeeded: ["gmail"],
      limit: 2,
      hasMore: true,
    });

    const exactService = new TriageService(new MessageRefStore());
    exactService.register(
      new HealthyAdapter("gmail", [ref("gmail", "1"), ref("gmail", "2")]),
    );
    const exact = await exactService.searchWithReceipt(runtime, {
      sources: ["gmail"],
      content: "hello",
      limit: 2,
    });
    expect(exact.refs).toHaveLength(2);
    expect(exact.receipt.hasMore).toBe(false);
  });

  it("searchWithReceipt exposes sources that were not searched", async () => {
    const service = new TriageService(new MessageRefStore());
    service.register(new HealthyAdapter("gmail", [ref("gmail", "1")]));
    const result = await service.searchWithReceipt(createFakeRuntime(), {
      sources: ["gmail", "discord"],
      content: "hello",
    });
    expect(result.receipt).toMatchObject({
      requested: ["gmail", "discord"],
      succeeded: ["gmail"],
      unregistered: ["discord"],
      hasMore: null,
      limit: null,
    });
  });

  it("the action never describes an unsearched source as covered", async () => {
    __resetDefaultTriageServiceForTests();
    getDefaultTriageService().register(
      new HealthyAdapter("gmail", [ref("gmail", "1")]),
    );
    const result = await searchMessagesAction.handler(
      createFakeRuntime(),
      {} as never,
      undefined,
      {
        parameters: {
          sources: ["gmail", "discord"],
          content: "hello",
          limit: 1,
        },
      } as never,
    );
    expect(result.text).toContain("Searched 1 of 2 requested source(s)");
    expect(result.text).toContain("discord (not registered)");
    expect(result.text).not.toContain("across connected channels");
    expect(result.data?.scope).toMatchObject({
      succeededSources: ["gmail"],
      unregisteredSources: ["discord"],
      filtersApplied: { content: true },
      hasMore: false,
    });
  });
});

it("owner-scoped live sources remove old metadata and do not retain new list or search results", async () => {
  const store = new MessageRefStore();
  const service = new TriageService(store),
    runtime = createFakeRuntime();
  store.saveMessages(
    [ref("gmail", "old-owner"), ref("discord", "kept")],
    runtime.agentId,
  );
  class OwnerSource extends HealthyAdapter {
    readonly cachePolicy = "none" as const;
  }
  service.register(new OwnerSource("gmail", [ref("gmail", "current-owner")]));
  expect(store.listMessages(runtime.agentId).map((row) => row.id)).toEqual([
    "discord:kept",
  ]);
  expect(
    (await service.triage(runtime, { sources: ["gmail"] })).map(
      (row) => row.id,
    ),
  ).toEqual(["gmail:current-owner"]);
  expect(
    (
      await service.search(runtime, {
        sources: ["gmail"],
        content: "hello",
        limit: 1,
      })
    ).map((row) => row.id),
  ).toEqual(["gmail:current-owner"]);
  expect(store.listMessages(runtime.agentId).map((row) => row.id)).toEqual([
    "discord:kept",
  ]);
});

it("does not double-probe array-only inbox searches, while receipt searches still detect overflow", async () => {
  const limits: Array<number | undefined> = [];
  class BoundedSource extends HealthyAdapter {
    capabilities(): MessageAdapterCapabilities {
      return { ...super.capabilities(), search: true };
    }
    protected async searchMessagesImpl(
      _runtime: IAgentRuntime,
      filters: SearchMessagesFilters,
    ): Promise<MessageRef[]> {
      limits.push(filters.limit);
      if (filters.limit === undefined || filters.limit > 51)
        throw new Error("Provider permits at most 50 messages plus one probe");
      return Array.from({ length: filters.limit }, (_, index) =>
        ref("gmail", String(index)),
      );
    }
  }
  const service = new TriageService(new MessageRefStore());
  service.register(new BoundedSource("gmail", []));
  const runtime = createFakeRuntime();
  const inboxProbe = await service.search(
    runtime,
    {
      sources: ["gmail"],
      limit: 51,
    },
    { probeOverflow: false },
  );
  expect(inboxProbe).toHaveLength(51);
  const result = await service.searchWithReceipt(runtime, {
    sources: ["gmail"],
    limit: 50,
  });
  expect(result.refs).toHaveLength(50);
  expect(result.receipt.hasMore).toBe(true);
  expect(limits).toEqual([51, 51]);
});
