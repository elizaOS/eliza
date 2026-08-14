/**
 * Exercises the SlopHub cutover operator against stateful provider HTTP
 * boundaries. The harness records every mutation and updates its in-memory
 * provider state, so apply must prove the same post-mutation reads production
 * will perform rather than passing on mocked return values alone.
 */

import { describe, expect, test } from "bun:test";

import {
  applySlopHubCutoverPlan,
  buildSlopHubCutoverPlan,
} from "./slophub-cutover";

const SOURCE_SHA = "a".repeat(40);
const environment = {
  CLOUDFLARE_ACCOUNT_ID: "account-1",
  CLOUDFLARE_API_TOKEN: "cloudflare-secret",
  HCLOUD_TOKEN: "hetzner-secret",
  SLOPHUB_SOURCE_SHA: SOURCE_SHA,
};

interface HarnessOptions {
  dropUnrelatedFirewallRulesAfterSet?: boolean;
  dnsRecords?: Record<string, unknown>[];
  firewallActionStatus?: "error" | "running" | "success";
  firewallPollStatus?: "error" | "success";
  firewalls?: Record<string, unknown>[];
  reverseFirewallRulesAfterSet?: boolean;
  servers?: Record<string, unknown>[];
  zoneAccountId?: string;
}

function harness(options: HarnessOptions = {}) {
  const state = {
    dnsRecords: structuredClone(options.dnsRecords ?? []),
    firewalls: structuredClone(
      options.firewalls ?? [
        {
          id: 90,
          name: "eliza-hub",
          applied_to: [{ type: "server", server: { id: 80 } }],
          rules: [
            {
              direction: "in",
              protocol: "tcp",
              port: "443",
              source_ips: ["0.0.0.0/0", "::/0"],
              description: "HTTPS",
            },
          ],
        },
      ],
    ),
    servers: structuredClone(
      options.servers ?? [
        {
          id: 80,
          name: "eliza-hub",
          public_net: { ipv4: { ip: "5.78.151.202" } },
        },
      ],
    ),
  };
  const mutations: Array<{ method: string; url: string; body: unknown }> = [];

  const request = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : null;
    const headers = new Headers(init.headers);
    const expectedAuthorization =
      url.hostname === "api.cloudflare.com"
        ? "Bearer cloudflare-secret"
        : "Bearer hetzner-secret";
    expect(headers.get("authorization")).toBe(expectedAuthorization);

    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname === "/client/v4/zones"
    ) {
      return Response.json({
        success: true,
        result: [
          {
            id: "zone-1",
            name: "slop.cash",
            account: { id: options.zoneAccountId ?? "account-1" },
          },
        ],
      });
    }
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname === "/client/v4/zones/zone-1/dns_records" &&
      method === "GET"
    ) {
      return Response.json({ success: true, result: state.dnsRecords });
    }
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname === "/client/v4/zones/zone-1/dns_records" &&
      method === "POST"
    ) {
      mutations.push({ method, url: url.href, body });
      state.dnsRecords = [{ id: "record-1", ...(body as object) }];
      return Response.json({ success: true, result: state.dnsRecords[0] });
    }
    if (
      url.hostname === "api.cloudflare.com" &&
      url.pathname === "/client/v4/zones/zone-1/dns_records/record-1" &&
      method === "PATCH"
    ) {
      mutations.push({ method, url: url.href, body });
      state.dnsRecords[0] = { ...state.dnsRecords[0], ...(body as object) };
      return Response.json({ success: true, result: state.dnsRecords[0] });
    }
    if (
      url.hostname === "api.hetzner.cloud" &&
      url.pathname === "/v1/servers"
    ) {
      return Response.json({
        servers: state.servers,
        meta: { pagination: { last_page: 1 } },
      });
    }
    if (
      url.hostname === "api.hetzner.cloud" &&
      url.pathname === "/v1/firewalls"
    ) {
      return Response.json({
        firewalls: state.firewalls,
        meta: { pagination: { last_page: 1 } },
      });
    }
    if (
      url.hostname === "api.hetzner.cloud" &&
      url.pathname === "/v1/firewalls/90/actions/set_rules" &&
      method === "POST"
    ) {
      mutations.push({ method, url: url.href, body });
      const requestedRules = (body as { rules: unknown[] }).rules;
      const retainedRules = options.dropUnrelatedFirewallRulesAfterSet
        ? requestedRules.filter(
            (rule) => (rule as { port?: string }).port === "2222",
          )
        : requestedRules;
      state.firewalls[0] = {
        ...state.firewalls[0],
        rules: options.reverseFirewallRulesAfterSet
          ? retainedRules.toReversed()
          : retainedRules,
      };
      return Response.json({
        action: { id: 100, status: options.firewallActionStatus ?? "success" },
      });
    }
    if (
      url.hostname === "api.hetzner.cloud" &&
      url.pathname === "/v1/actions/100"
    ) {
      return Response.json({
        action: { id: 100, status: options.firewallPollStatus ?? "success" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  return { state, mutations, request: request as typeof fetch };
}

function desiredRecord() {
  return {
    id: "record-1",
    type: "A",
    name: "git.slop.cash",
    content: "5.78.151.202",
    proxied: false,
    ttl: 1,
  };
}

function desiredSshRule() {
  return {
    direction: "in",
    protocol: "tcp",
    port: "2222",
    source_ips: ["0.0.0.0/0", "::/0"],
    description: "Public SlopHub Forgejo SSH",
  };
}

describe("SlopHub cutover plan", () => {
  test("plans only the missing DNS record and SSH rule without exposing credentials", async () => {
    const provider = harness();
    const plan = await buildSlopHubCutoverPlan(environment, provider.request);

    expect(plan.cloudflare.action).toBe("create");
    expect(plan.hetzner.action).toBe("add-rule");
    expect(plan.hetzner.nextRules).toEqual([
      ...plan.hetzner.beforeRules,
      desiredSshRule(),
    ]);
    expect(JSON.stringify(plan)).not.toContain("cloudflare-secret");
    expect(JSON.stringify(plan)).not.toContain("hetzner-secret");
    expect(provider.mutations).toEqual([]);
  });

  test("reports a complete no-op when both providers already match", async () => {
    const provider = harness({
      dnsRecords: [desiredRecord()],
      firewalls: [
        {
          id: 90,
          name: "eliza-hub",
          applied_to: [{ type: "server", server: { id: 80 } }],
          rules: [desiredSshRule()],
        },
      ],
    });
    const plan = await buildSlopHubCutoverPlan(environment, provider.request);
    expect(plan.cloudflare.action).toBe("noop");
    expect(plan.hetzner.action).toBe("noop");
  });

  test("fails closed on DNS conflicts, account mismatch, server ambiguity, or firewall ambiguity", async () => {
    const cases = [
      harness({
        dnsRecords: [desiredRecord(), { ...desiredRecord(), id: "record-2" }],
      }),
      harness({
        dnsRecords: [
          { ...desiredRecord(), type: "CNAME", content: "wrong.example" },
        ],
      }),
      harness({
        dnsRecords: [{ ...desiredRecord(), name: "other.slop.cash" }],
      }),
      harness({ zoneAccountId: "other-account" }),
      harness({
        servers: [
          { id: 80, name: "one", public_net: { ipv4: { ip: "5.78.151.202" } } },
          { id: 81, name: "two", public_net: { ipv4: { ip: "5.78.151.202" } } },
        ],
      }),
      harness({
        firewalls: [
          {
            id: 90,
            name: "one",
            applied_to: [{ type: "server", server: { id: 80 } }],
            rules: [],
          },
          {
            id: 91,
            name: "two",
            applied_to: [{ type: "server", server: { id: 80 } }],
            rules: [],
          },
        ],
      }),
      harness({
        firewalls: [
          {
            id: 90,
            name: "shared",
            applied_to: [
              { type: "server", server: { id: 80 } },
              { type: "server", server: { id: 81 } },
            ],
            rules: [],
          },
        ],
      }),
      harness({
        firewalls: [
          {
            id: 90,
            name: "selector",
            applied_to: [
              {
                type: "label_selector",
                label_selector: { selector: "role=git" },
              },
            ],
            rules: [],
          },
        ],
      }),
    ];
    for (const provider of cases) {
      await expect(
        buildSlopHubCutoverPlan(environment, provider.request),
      ).rejects.toThrow();
      expect(provider.mutations).toEqual([]);
    }
  });
});

describe("SlopHub cutover apply", () => {
  test("applies the exact reviewed changes, preserves unrelated rules, and proves convergence", async () => {
    const provider = harness();
    const reviewed = await buildSlopHubCutoverPlan(
      environment,
      provider.request,
    );
    const verified = await applySlopHubCutoverPlan(
      reviewed,
      environment,
      provider.request,
    );

    expect(verified.cloudflare.action).toBe("noop");
    expect(verified.hetzner.action).toBe("noop");
    expect(provider.mutations.map(({ method }) => method)).toEqual([
      "POST",
      "POST",
    ]);
    expect(provider.mutations.map(({ url }) => new URL(url).hostname)).toEqual([
      "api.hetzner.cloud",
      "api.cloudflare.com",
    ]);
    expect(provider.state.firewalls[0]?.rules).toEqual([
      reviewed.hetzner.beforeRules[0],
      desiredSshRule(),
    ]);
  });

  test("continues idempotently when one reviewed leg was already applied", async () => {
    const provider = harness();
    const reviewed = await buildSlopHubCutoverPlan(
      environment,
      provider.request,
    );
    provider.state.dnsRecords = [desiredRecord()];

    const verified = await applySlopHubCutoverPlan(
      reviewed,
      environment,
      provider.request,
    );
    expect(verified.cloudflare.action).toBe("noop");
    expect(verified.hetzner.action).toBe("noop");
    expect(provider.mutations.map(({ url }) => url)).toEqual([
      "https://api.hetzner.cloud/v1/firewalls/90/actions/set_rules",
    ]);
  });

  test("rejects source mismatch and live drift before any mutation", async () => {
    const provider = harness({
      dnsRecords: [{ ...desiredRecord(), content: "5.78.151.201" }],
    });
    const reviewed = await buildSlopHubCutoverPlan(
      environment,
      provider.request,
    );

    await expect(
      applySlopHubCutoverPlan(
        reviewed,
        { ...environment, SLOPHUB_SOURCE_SHA: "b".repeat(40) },
        provider.request,
      ),
    ).rejects.toThrow(/source validation/);
    provider.state.dnsRecords[0] = {
      ...desiredRecord(),
      content: "5.78.151.200",
    };
    await expect(
      applySlopHubCutoverPlan(reviewed, environment, provider.request),
    ).rejects.toThrow(/drifted/);
    expect(provider.mutations).toEqual([]);
  });

  test("rejects when a reviewed no-op drifts into a mutation", async () => {
    const provider = harness({
      dnsRecords: [desiredRecord()],
      firewalls: [
        {
          id: 90,
          name: "eliza-hub",
          applied_to: [{ type: "server", server: { id: 80 } }],
          rules: [desiredSshRule()],
        },
      ],
    });
    const reviewed = await buildSlopHubCutoverPlan(
      environment,
      provider.request,
    );
    provider.state.dnsRecords[0] = {
      ...desiredRecord(),
      content: "5.78.151.201",
    };

    await expect(
      applySlopHubCutoverPlan(reviewed, environment, provider.request),
    ).rejects.toThrow(/drifted/);
    expect(provider.mutations).toEqual([]);
  });

  test("patches one existing A record without deleting its identity or unrelated firewall rules", async () => {
    const provider = harness({
      dnsRecords: [
        {
          ...desiredRecord(),
          content: "5.78.151.201",
          proxied: true,
          ttl: 300,
        },
      ],
      firewalls: [
        {
          id: 90,
          name: "eliza-hub",
          applied_to: [{ type: "server", server: { id: 80 } }],
          rules: [desiredSshRule()],
        },
      ],
    });
    const reviewed = await buildSlopHubCutoverPlan(
      environment,
      provider.request,
    );
    const verified = await applySlopHubCutoverPlan(
      reviewed,
      environment,
      provider.request,
    );
    expect(verified.cloudflare.recordId).toBe("record-1");
    expect(provider.mutations).toHaveLength(1);
    expect(provider.mutations[0]).toMatchObject({
      method: "PATCH",
      body: { content: "5.78.151.202", proxied: false },
    });
    expect(provider.state.dnsRecords[0]?.ttl).toBe(300);
  });

  test("fails when Hetzner reports an action error or drops an unrelated rule", async () => {
    const actionError = harness({ firewallActionStatus: "error" });
    const actionErrorPlan = await buildSlopHubCutoverPlan(
      environment,
      actionError.request,
    );
    await expect(
      applySlopHubCutoverPlan(
        actionErrorPlan,
        environment,
        actionError.request,
      ),
    ).rejects.toThrow();
    expect(
      actionError.mutations.every(
        ({ url }) => !url.includes("api.cloudflare.com"),
      ),
    ).toBe(true);

    const droppedRule = harness({ dropUnrelatedFirewallRulesAfterSet: true });
    const droppedRulePlan = await buildSlopHubCutoverPlan(
      environment,
      droppedRule.request,
    );
    await expect(
      applySlopHubCutoverPlan(
        droppedRulePlan,
        environment,
        droppedRule.request,
      ),
    ).rejects.toThrow(/ingress did not match/);
    expect(
      droppedRule.mutations.every(
        ({ url }) => !url.includes("api.cloudflare.com"),
      ),
    ).toBe(true);
    expect(droppedRule.state.dnsRecords).toEqual([]);
  });

  test("waits for an asynchronous Hetzner action and ignores provider rule ordering", async () => {
    const provider = harness({
      firewallActionStatus: "running",
      firewallPollStatus: "success",
      reverseFirewallRulesAfterSet: true,
    });
    const reviewed = await buildSlopHubCutoverPlan(
      environment,
      provider.request,
    );
    const verified = await applySlopHubCutoverPlan(
      reviewed,
      environment,
      provider.request,
    );
    expect(verified.cloudflare.action).toBe("noop");
    expect(verified.hetzner.action).toBe("noop");
    expect(provider.state.firewalls[0]?.rules).toEqual([
      desiredSshRule(),
      reviewed.hetzner.beforeRules[0],
    ]);
  });
});
