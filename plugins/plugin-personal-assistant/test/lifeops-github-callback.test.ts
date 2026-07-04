// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  LIFEOPS_GITHUB_POST_MESSAGE_TYPE,
  readLifeOpsGithubCallbackFromUrl,
  readLifeOpsGithubCallbackFromWindowMessage,
} from "../src/platform/lifeops-github.js";

/**
 * GitHub OAuth callback parsing (#8833) reads untrusted postMessage payloads and
 * deep-link URLs. It must validate the message type, the elizaos: scheme, the
 * target enum (owner/agent), and the status enum (connected/error) — rejecting
 * anything else to null so a forged callback can't bind a connection.
 */

describe("readLifeOpsGithubCallbackFromWindowMessage", () => {
  it("accepts a well-typed callback, rejects wrong type/enum/shape", () => {
    expect(
      readLifeOpsGithubCallbackFromWindowMessage({
        type: LIFEOPS_GITHUB_POST_MESSAGE_TYPE,
        target: "owner",
        status: "connected",
        connectionId: "c1",
      }),
    ).toMatchObject({
      target: "owner",
      status: "connected",
      connectionId: "c1",
    });

    expect(
      readLifeOpsGithubCallbackFromWindowMessage({
        type: "some-other-type",
        target: "owner",
        status: "connected",
      }),
    ).toBeNull();
    expect(
      readLifeOpsGithubCallbackFromWindowMessage({
        type: LIFEOPS_GITHUB_POST_MESSAGE_TYPE,
        target: "attacker",
        status: "connected",
      }),
    ).toBeNull();
    expect(readLifeOpsGithubCallbackFromWindowMessage("nope")).toBeNull();
  });
});

describe("readLifeOpsGithubCallbackFromUrl", () => {
  it("parses elizaos://lifeops|settings callbacks, rejects others", () => {
    expect(
      readLifeOpsGithubCallbackFromUrl(
        "elizaos://lifeops?github_target=owner&github_status=connected&connection_id=c1",
      ),
    ).toMatchObject({
      target: "owner",
      status: "connected",
      connectionId: "c1",
    });
    expect(
      readLifeOpsGithubCallbackFromUrl(
        "elizaos://settings?github_target=agent&github_status=error",
      ),
    ).toMatchObject({ target: "agent", status: "error" });

    // wrong scheme / path / garbage → null
    expect(
      readLifeOpsGithubCallbackFromUrl(
        "https://x.com/?github_target=owner&github_status=connected",
      ),
    ).toBeNull();
    expect(
      readLifeOpsGithubCallbackFromUrl(
        "elizaos://other?github_target=owner&github_status=connected",
      ),
    ).toBeNull();
    expect(readLifeOpsGithubCallbackFromUrl("not a url")).toBeNull();
  });
});
