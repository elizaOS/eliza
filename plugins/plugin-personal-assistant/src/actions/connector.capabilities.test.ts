/**
 * Exercises CONNECTOR argument validation through the real LifeOps domain,
 * account manager, and Google consent-URL generator with in-memory flow storage.
 * Owner access and parsed model arguments are supplied by the deterministic test
 * harness; no authorization callback, provider request, or account grant occurs.
 */
import {
  AgentRuntime,
  createCharacter,
  getConnectorAccountManager,
  InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateToolArgs } from "../../../../packages/core/src/actions/validate-tool-args.js";
import { createGoogleConnectorAccountProvider } from "../../../plugin-google-workspace/src/connector-account-provider.js";
import { connectorAction } from "./connector.js";

vi.mock("@elizaos/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/agent")>()),
  extractActionParamsViaLlm: async ({
    existingParams,
  }: {
    existingParams: Record<string, unknown>;
  }) => existingParams,
}));

const callback = "http://127.0.0.1:31437/api/connectors/google/oauth/callback";
let runtime: AgentRuntime;

beforeEach(() => {
  runtime = new AgentRuntime({
    character: createCharacter({ name: "Google scope contract" }),
  });
  runtime.setSetting("GOOGLE_CLIENT_ID", "synthetic-client");
  runtime.setSetting("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  runtime.setSetting("GOOGLE_REDIRECT_URI", callback);
  runtime.setSetting("ELIZA_API_PORT", "31437");
  const manager = getConnectorAccountManager(
    runtime,
    new InMemoryConnectorAccountStorage(),
  );
  manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
});

afterEach(async () => {
  await runtime.stop();
});

async function connect(parameters: Record<string, unknown>) {
  const validation = validateToolArgs(connectorAction, parameters);
  expect(validation.errors).toEqual([]);
  expect(validation.valid).toBe(true);
  return connectorAction.handler(
    runtime,
    {
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: runtime.agentId,
      content: {
        text: "Connect my Google account with the requested permissions.",
      },
    },
    undefined,
    { parameters },
  );
}

describe("CONNECTOR Google capability selection", () => {
  it("carries the selected permissions into the actual consent URL and stored flow", async () => {
    const result = await connect({
      connector: "google",
      action: "connect",
      capabilities: ["google.gmail.triage"],
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ awaitingUserAction: true });
    const match = result.text?.match(/https:\/\/accounts\.google\.com\/\S+/);
    expect(match).not.toBeNull();
    if (!match)
      throw new Error("Google consent URL missing from action result");
    const consent = new URL(match[0]);
    const scopes = new Set(consent.searchParams.get("scope")?.split(" "));
    expect(scopes.has("https://www.googleapis.com/auth/gmail.readonly")).toBe(
      true,
    );
    expect(
      [...scopes].filter(
        (scope) =>
          scope.includes("/auth/") && !scope.includes("/auth/userinfo."),
      ),
    ).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(consent.searchParams.get("redirect_uri")).toBe(callback);
    const state = consent.searchParams.get("state");
    if (!state) throw new Error("Google consent state missing");
    const flow = await getConnectorAccountManager(runtime).getOAuthFlow(
      "google",
      state,
    );
    expect(flow?.authUrl).toBe(consent.toString());
    expect(flow?.status).toBe("pending");
    expect(flow?.metadata?.requestedScopes).toEqual([...scopes]);
  });

  it("rejects unsupported capabilities at the argument boundary", () => {
    const result = validateToolArgs(connectorAction, {
      connector: "google",
      action: "connect",
      capabilities: ["google.drive.read"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/capabilities/);
  });

  it.each([
    { label: "omitted", capabilities: undefined },
    { label: "empty", capabilities: [] },
  ])(
    "does not broaden a new grant when capabilities are $label",
    async ({ capabilities }) => {
      const parameters = {
        connector: "google",
        action: "connect",
        ...(capabilities === undefined ? {} : { capabilities }),
      };
      await expect(connect(parameters)).rejects.toMatchObject({
        code: "GOOGLE_OAUTH_CAPABILITY_REQUIRED",
      });
    },
  );
});
