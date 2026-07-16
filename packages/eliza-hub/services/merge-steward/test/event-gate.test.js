import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gateForgejoEvent } from "../src/event-gate.js";

describe("Forgejo event gate", () => {
  it("allows events when disabled", () => {
    assert.deepEqual(gateForgejoEvent(event(), { enabled: false }), {
      allowed: true,
      action: "allow",
      reason: "event_gate_disabled",
    });
  });

  it("blocks events from unconfigured repositories", () => {
    const result = gateForgejoEvent(event(), {
      enabled: true,
      repositories: ["elizaos/runtime"],
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, "repository_not_allowed");
  });

  it("blocks fork pull requests unless explicitly allowed", () => {
    const result = gateForgejoEvent(
      event({
        pullRequest: {
          ...basePullRequest,
          head: {
            ...basePullRequest.head,
            repo: {
              fullName: "fork/eliza",
              fork: true,
            },
          },
        },
      }),
      {
        enabled: true,
        repositories: ["elizaos/eliza"],
      },
    );

    assert.equal(result.allowed, false);
    assert.equal(result.reason, "fork_pull_request_blocked");
  });

  it("blocks comment commands from untrusted actors", () => {
    const result = gateForgejoEvent(
      event({
        kind: "pull_request_comment",
        type: "pull_request_comment.created",
        comment: { body: "/eliza merge this", author: { login: "agent-one" } },
        actor: { login: "agent-one" },
      }),
      {
        enabled: true,
        repositories: ["elizaos/eliza"],
        trustedActors: ["maintainer-one"],
      },
    );

    assert.equal(result.allowed, false);
    assert.equal(result.reason, "comment_command_unauthorized");
  });

  it("allows configured trusted repository events", () => {
    const result = gateForgejoEvent(event(), {
      enabled: true,
      repositories: ["elizaos/eliza"],
    });

    assert.equal(result.allowed, true);
    assert.equal(result.reason, "event_gate_allowed");
  });
});

const baseRepository = Object.freeze({
  fullName: "elizaos/eliza",
  fork: false,
});

const basePullRequest = Object.freeze({
  number: 12,
  state: "open",
  base: {
    repo: baseRepository,
  },
  head: {
    repo: baseRepository,
  },
});

function event(overrides = {}) {
  return {
    source: "forgejo",
    type: "pull_request.opened",
    kind: "pull_request",
    action: "opened",
    repository: baseRepository,
    pullRequest: basePullRequest,
    actor: { login: "agent-one" },
    ...overrides,
  };
}
