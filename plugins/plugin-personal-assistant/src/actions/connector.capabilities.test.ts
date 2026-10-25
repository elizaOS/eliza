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
  validateToolArgs,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleConnectorAccountProvider } from "../../../plugin-google-workspace/src/connector-account-provider.js";
import { connectorAction } from "./connector.js";

vi.mock("@elizaos/plugin-assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/plugin-assistant")>()),
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

  it.each(["cloud_managed", "remote"])(
    "names the mode argument when Google is asked for mode %s",
    async (mode) => {
      for (const parameters of [
        {
          connector: "google",
          action: "connect",
          mode,
          capabilities: ["google.calendar.read"],
        },
        { connector: "google", action: "disconnect", mode },
      ]) {
        expect(validateToolArgs(connectorAction, parameters).valid).toBe(true);
        const result = (await connectorAction.handler(
          runtime,
          {
            agentId: runtime.agentId,
            entityId: runtime.agentId,
            roomId: runtime.agentId,
            content: { text: `${parameters.action} my Google account` },
          },
          undefined,
          { parameters },
        )) as { success: boolean; text: string; data: Record<string, unknown> };
        expect(result.success).toBe(false);
        expect(result.data.error).toBe("GOOGLE_MODE_UNSUPPORTED");
        expect(result.text).toContain(`mode "${mode}"`);
        expect(result.data.requiresConfirmation).toBeUndefined();
      }
    },
  );

  it("refuses a disconnect that can only fail without first asking the owner to confirm", async () => {
    const disconnect = async (connector: string) => {
      const parameters = { action: "disconnect", connector };
      expect(validateToolArgs(connectorAction, parameters).valid).toBe(true);
      const result = await connectorAction.handler(
        runtime,
        {
          agentId: runtime.agentId,
          entityId: runtime.agentId,
          roomId: runtime.agentId,
          content: { text: `disconnect my ${connector}` },
        },
        undefined,
        { parameters },
      );
      return result as {
        success: boolean;
        data: Record<string, unknown>;
      };
    };

    const unknown = await disconnect("slack");
    expect(unknown.success).toBe(false);
    expect(unknown.data.error).toBe("UNKNOWN_CONNECTOR");
    expect(unknown.data.requiresConfirmation).toBeUndefined();

    const unsupported = await disconnect("wechat");
    expect(unsupported.success).toBe(false);
    expect(unsupported.data.error).toBe("UNSUPPORTED_OPERATION");
    expect(unsupported.data.requiresConfirmation).toBeUndefined();

    const google = await disconnect("google");
    expect(google.success).toBe(false);
    expect(google.data.requiresConfirmation).toBe(true);
  });
});
