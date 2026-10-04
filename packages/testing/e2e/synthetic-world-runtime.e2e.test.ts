/** Production GitHub action and SQL confirmation state against the world's real HTTP API. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type IAgentRuntime,
  type Memory,
  trackPostDeliveryTask,
} from "@elizaos/core";
import { GitHubService, issueOpAction } from "@elizaos/plugin-github";
import { Octokit } from "@octokit/rest";
import { createSyntheticTestRuntime } from "../src/synthetic-runtime.ts";
import { SqliteSyntheticEnvironmentLeaseStore } from "../synthetic-world/src/sqlite-lease-store.ts";

test("a rejected GitHub write has no API effect; confirmation persists then creates one issue", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "synthetic-runtime-"));
  const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(directory, "lease.sqlite"),
  );
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const fixture = await createSyntheticTestRuntime({
      world: {
        leaseStore,
        manifest: {
          version: 1,
          namespace: "github-confirmation",
          manifestId: "github-v1",
          domains: { github: {} },
        },
      },
      runtime: (world) => {
        class WorldGitHubService extends GitHubService {
          static override start(runtime: IAgentRuntime) {
            return GitHubService.start(
              runtime,
              (auth) => new Octokit({ auth, baseUrl: world.endpoints.github }),
            );
          }
        }
        return {
          settings: {
            GITHUB_ACCOUNTS: JSON.stringify([
              {
                accountId: "agent",
                role: "agent",
                token: "synthetic-github-token",
              },
            ]),
            ELIZA_CANONICAL_EMBEDDINGS_ENABLED: false,
          },
          plugins: [
            {
              name: "synthetic-github-transport",
              description:
                "Production GitHub service with explicit HTTP transport",
              services: [WorldGitHubService],
              actions: [issueOpAction],
            },
          ],
        };
      },
    });
    cleanup = fixture.cleanup;
    const { runtime, world } = fixture;
    await runtime.getServiceLoadPromise(GitHubService.serviceType);
    const message = (text: string): Memory => ({
      entityId: runtime.agentId,
      roomId: runtime.agentId,
      content: { text },
    });
    const options = {
      op: "create",
      repo: "elizaOS/eliza",
      title: "Synthetic confirmation",
      body: "Full content survives the HTTP boundary.",
    };
    const pending = await issueOpAction.handler(
      runtime,
      message("Create the issue"),
      undefined,
      options,
    );
    expect(pending).toMatchObject({
      success: false,
      requiresConfirmation: true,
    });
    const rejected = await issueOpAction.handler(
      runtime,
      message("no"),
      undefined,
      options,
    );
    expect(rejected).toMatchObject({ success: false });
    expect(world.requestLedger()).toHaveLength(0);
    await issueOpAction.handler(
      runtime,
      message("Create the issue"),
      undefined,
      options,
    );
    const approved = await issueOpAction.handler(
      runtime,
      message("yes"),
      undefined,
      options,
    );
    expect(approved).toMatchObject({ success: true, data: { op: "create" } });
    expect(
      world.requestLedger().filter((entry) => entry.method === "POST"),
    ).toHaveLength(1);
    expect(JSON.stringify(world.snapshot())).toContain(options.body);
    await cleanup();
    expect((await leaseStore.read("github-confirmation"))?.status).toBe(
      "released",
    );
  } finally {
    await cleanup?.();
    leaseStore.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test("the scenario executor carries a complete two-service journey and world evidence through teardown", async () => {
  const { runSyntheticScenario } = await import(
    "../scenario-runner/src/synthetic-scenario.ts"
  );
  const directory = await mkdtemp(path.join(tmpdir(), "synthetic-journey-"));
  const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(directory, "lease.sqlite"),
  );
  const title = "Cross-service scenario";
  const body = `${"Complete issue content. ".repeat(1000)}final sentinel`;
  try {
    const result = await runSyntheticScenario({
      world: {
        leaseStore,
        manifest: {
          version: 1,
          namespace: "two-service-journey",
          manifestId: "journey-v1",
          domains: { github: {}, slack: {} },
        },
      },
      runtime: (world) => ({
        plugins: [
          {
            name: "scenario-transport-journey",
            description: "Exercises executor and API world transport together",
            actions: [
              {
                name: "PUBLISH_SCENARIO_ISSUE",
                description: "Create a fixture issue and announce its URL",
                similes: [],
                examples: [],
                validate: async () => true,
                handler: async () => {
                  const client = new Octokit({
                    auth: "synthetic-token",
                    baseUrl: world.endpoints.github,
                  });
                  const issue = await client.issues.create({
                    owner: "elizaOS",
                    repo: "eliza",
                    title,
                    body,
                  });
                  const response = await fetch(
                    `${world.endpoints.slack}/api/chat.postMessage`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        channel: "C001",
                        text: issue.data.html_url,
                      }),
                      signal: world.signal,
                    },
                  );
                  if (!response.ok)
                    throw new Error(
                      `Slack transport failed: ${response.status}`,
                    );
                  const slack = await response.json();
                  if (slack.ok !== true)
                    throw new Error("Slack did not confirm the message");
                  return {
                    success: true,
                    text: "Created and announced",
                    data: {
                      issue: issue.data.number,
                      slackTimestamp: slack.ts,
                    },
                  };
                },
              },
            ],
          },
        ],
      }),
      scenario: {
        id: "synthetic.two-service-journey",
        title: "Publish and announce",
        domain: "synthetic-world",
        lane: "pr-deterministic",
        turns: [
          {
            kind: "action",
            name: "publish",
            actionName: "PUBLISH_SCENARIO_ISSUE",
            expectedActions: ["PUBLISH_SCENARIO_ISSUE"],
            assertTurn(turn) {
              if (turn.actionsCalled[0]?.result?.success !== true)
                return "Publication was not confirmed";
            },
          },
        ],
        finalChecks: [
          { type: "actionCalled", actionName: "PUBLISH_SCENARIO_ISSUE" },
        ],
      },
      executor: {
        providerName: "deterministic",
        minJudgeScore: 0.7,
        turnTimeoutMs: 30_000,
      },
    });
    expect(result.report.status).toBe("passed");
    expect(
      result.worldEvidence.requests.map((r) => [r.service, r.method]),
    ).toEqual([
      ["github", "POST"],
      ["slack", "POST"],
    ]);
    expect(JSON.stringify(result.worldEvidence.after)).toContain(body);
    expect(JSON.stringify(result.worldEvidence.before)).not.toContain(title);
    expect((await leaseStore.read("two-service-journey"))?.status).toBe(
      "released",
    );
  } finally {
    leaseStore.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test.each(["none", "immediate", "deferred"] as const)(
  "the full executor independently checks rejected API effects (leaked=%s)",
  async (leaked) => {
    const { runSyntheticScenario } = await import(
      "../scenario-runner/src/synthetic-scenario.ts"
    );
    const directory = await mkdtemp(
      path.join(tmpdir(), "synthetic-rejection-"),
    );
    const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(directory, "lease.sqlite"),
    );
    try {
      const result = await runSyntheticScenario({
        world: {
          leaseStore,
          manifest: {
            version: 1,
            namespace: "rejection",
            manifestId: "rejection-v1",
            domains: { slack: {} },
          },
        },
        runtime: (world) => ({
          plugins: [
            {
              name: "rejection-transport",
              description:
                "Actual HTTP effects independently observed around each action",
              actions: [
                {
                  name: "SEND_REVIEW_MESSAGE",
                  description: "Exercise approval gating",
                  similes: [],
                  examples: [],
                  validate: async () => true,
                  handler: async (_runtime, _message, _state, options) => {
                    const confirmed = options?.confirmed === true;
                    const write = async () => {
                      const response = await fetch(
                        `${world.endpoints.slack}/api/chat.postMessage`,
                        {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({
                            channel: "C001",
                            text: confirmed ? "approved" : "leaked",
                          }),
                          signal: world.signal,
                        },
                      );
                      if (!response.ok)
                        throw new Error(
                          `Slack request failed: ${response.status}`,
                        );
                      await response.arrayBuffer();
                    };
                    if (confirmed || leaked === "immediate") await write();
                    else if (leaked === "deferred") {
                      void trackPostDeliveryTask(
                        _runtime,
                        "deferred-api-write",
                        async () => {
                          await new Promise((resolve) =>
                            setTimeout(resolve, 25),
                          );
                          await write();
                        },
                      );
                    }
                    return {
                      success: true,
                      data: confirmed
                        ? { completed: true }
                        : { cancelled: true },
                    };
                  },
                },
              ],
            },
          ],
        }),
        scenario: {
          id: "synthetic.rejection",
          title: "Observe rejected effects",
          domain: "synthetic-world",
          lane: "pr-deterministic",
          turns: [
            {
              kind: "action",
              name: "reject",
              actionName: "SEND_REVIEW_MESSAGE",
              options: { confirmed: false },
            },
            {
              kind: "action",
              name: "approve",
              actionName: "SEND_REVIEW_MESSAGE",
              options: { confirmed: true },
            },
          ],
          finalChecks: [
            { type: "noSideEffectOnReject", actionName: "SEND_REVIEW_MESSAGE" },
          ],
        },
        executor: {
          providerName: "deterministic",
          minJudgeScore: 0.7,
          turnTimeoutMs: 30_000,
        },
      });
      expect(result.report.status).toBe(
        leaked !== "none" ? "failed" : "passed",
      );
      expect(result.report.finalChecks[0]?.status).toBe(
        leaked !== "none" ? "failed" : "passed",
      );
      expect(result.worldEvidence.requests).toHaveLength(
        leaked !== "none" ? 2 : 1,
      );
    } finally {
      leaseStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
