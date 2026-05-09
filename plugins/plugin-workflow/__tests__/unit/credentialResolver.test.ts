import { describe, test, expect, mock } from "bun:test";
import { resolveCredentials } from "../../src/utils/credentialResolver";
import {
  createValidWorkflow,
  createGmailNode,
  createSlackNode,
  createTriggerNode,
  createWorkflowWithPlaceholderCreds,
} from "../fixtures/workflows";
import type {
  WorkflowPluginConfig,
  CredentialProvider,
  WorkflowCredentialStoreApi,
  CredentialProviderResult,
} from "../../src/types/index";

interface CredentialApiClient {
  createCredential(credential: {
    name: string;
    type: string;
    data: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

function createMockCredStore(
  overrides?: Partial<WorkflowCredentialStoreApi>,
): WorkflowCredentialStoreApi {
  return {
    get: mock(() => Promise.resolve(null)),
    set: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function createMockCredProvider(
  resolveFn?: (
    userId: string,
    credType: string,
  ) => Promise<CredentialProviderResult>,
): CredentialProvider {
  return {
    resolve: mock(resolveFn ?? (() => Promise.resolve(null))),
  };
}

function createMockApiClient(overrides?: Partial<CredentialApiClient>): CredentialApiClient {
  return {
    createCredential: mock(() =>
      Promise.resolve({
        id: "p1p3s-cred-123",
        name: "gmailOAuth2Api",
        type: "gmailOAuth2Api",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
    ),
    ...overrides,
  } as unknown as CredentialApiClient;
}

const baseConfig: WorkflowPluginConfig = { apiKey: "embedded", host: "in-process" };
const testTagName = "user:user-001";

// ============================================================================
// resolveCredentials
// ============================================================================

describe("resolveCredentials", () => {
  test("returns unchanged workflow when no credentials needed", async () => {
    const workflow = createValidWorkflow({
      nodes: [
        createTriggerNode(),
        { ...createGmailNode(), credentials: undefined },
      ],
    });

    const res = await resolveCredentials(
      workflow,
      "user-001",
      baseConfig,
      null,
      null,
      null,
      testTagName,
    );
    expect(res.missingConnections).toHaveLength(0);
    expect(res.injectedCredentials.size).toBe(0);
  });

  test("reports missing when no config, no store, no provider", async () => {
    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      null,
      null,
      null,
      testTagName,
    );
    expect(res.missingConnections.length).toBeGreaterThan(0);
    expect(res.missingConnections[0].credType).toBe("gmailOAuth2Api");
  });

  // --------------------------------------------------------------------------
  // Static config mode
  // --------------------------------------------------------------------------

  test("config mode: injects credential IDs from config", async () => {
    const config: WorkflowPluginConfig = {
      ...baseConfig,
      credentials: { gmailOAuth2Api: "preconfigured-cred-id" },
    };

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      config,
      null,
      null,
      null,
      testTagName,
    );
    expect(res.injectedCredentials.get("gmailOAuth2Api")).toBe(
      "preconfigured-cred-id",
    );
    const gmailNode = res.workflow.nodes.find((n) => n.name === "Gmail");
    expect(gmailNode?.credentials?.gmailOAuth2Api.id).toBe(
      "preconfigured-cred-id",
    );
  });

  test("config mode: fuzzy match without Api suffix", async () => {
    const config: WorkflowPluginConfig = {
      ...baseConfig,
      credentials: { gmailOAuth2: "gmail-cred-from-config" },
    };

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      config,
      null,
      null,
      null,
      testTagName,
    );
    expect(res.injectedCredentials.get("gmailOAuth2Api")).toBe(
      "gmail-cred-from-config",
    );
    expect(res.missingConnections).toHaveLength(0);
  });

  test("config mode: fuzzy match with Api suffix", async () => {
    const workflow = createValidWorkflow({
      nodes: [
        createTriggerNode(),
        {
          ...createGmailNode(),
          credentials: { gmailOAuth2: { id: "PLACEHOLDER", name: "Gmail" } },
        },
      ],
    });
    const config: WorkflowPluginConfig = {
      ...baseConfig,
      credentials: { gmailOAuth2Api: "gmail-cred-with-api" },
    };

    const res = await resolveCredentials(
      workflow,
      "user-001",
      config,
      null,
      null,
      null,
      testTagName,
    );
    expect(res.injectedCredentials.get("gmailOAuth2")).toBe(
      "gmail-cred-with-api",
    );
    expect(res.missingConnections).toHaveLength(0);
  });

  test("config mode: handles multiple credential types", async () => {
    const workflow = createValidWorkflow({
      nodes: [createTriggerNode(), createGmailNode(), createSlackNode()],
    });
    const config: WorkflowPluginConfig = {
      ...baseConfig,
      credentials: { gmailOAuth2Api: "gmail-cred", slackApi: "slack-cred" },
    };

    const res = await resolveCredentials(
      workflow,
      "user-001",
      config,
      null,
      null,
      null,
      testTagName,
    );
    expect(res.injectedCredentials.get("gmailOAuth2Api")).toBe("gmail-cred");
    expect(res.injectedCredentials.get("slackApi")).toBe("slack-cred");
  });

  // --------------------------------------------------------------------------
  // Credential store DB mode
  // --------------------------------------------------------------------------

  test("db mode: resolves from credential store", async () => {
    const credStore = createMockCredStore({
      get: mock(() => Promise.resolve("cached-cred-id")),
    });

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      credStore,
      null,
      null,
      testTagName,
    );
    expect(res.injectedCredentials.get("gmailOAuth2Api")).toBe(
      "cached-cred-id",
    );
    expect(res.missingConnections).toHaveLength(0);
  });

  test("db mode: takes priority over config", async () => {
    const credStore = createMockCredStore({
      get: mock(() => Promise.resolve("db-cred-id")),
    });
    const config: WorkflowPluginConfig = {
      ...baseConfig,
      credentials: { gmailOAuth2Api: "config-cred-id" },
    };

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      config,
      credStore,
      null,
      null,
      testTagName,
    );
    expect(res.injectedCredentials.get("gmailOAuth2Api")).toBe("db-cred-id");
  });

  // --------------------------------------------------------------------------
  // External provider mode — credential_data
  // --------------------------------------------------------------------------

  test("provider mode: creates p1p3s credential from credential_data", async () => {
    const oauthData = {
      clientId: "goog-client-id",
      clientSecret: "goog-secret",
      oauthTokenData: { access_token: "tok-123", token_type: "Bearer" },
    };

    const provider = createMockCredProvider(async () => ({
      status: "credential_data" as const,
      data: oauthData,
    }));

    const apiClient = createMockApiClient();
    const credStore = createMockCredStore();

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      credStore,
      provider,
      apiClient,
      testTagName,
    );

    expect(apiClient.createCredential).toHaveBeenCalledWith({
      name: `gmailOAuth2Api_${testTagName}`,
      type: "gmailOAuth2Api",
      data: oauthData,
    });
    expect(res.injectedCredentials.get("gmailOAuth2Api")).toBe("p1p3s-cred-123");
    expect(res.missingConnections).toHaveLength(0);
  });

  test("provider mode: caches p1p3s credential ID after creation", async () => {
    const provider = createMockCredProvider(async () => ({
      status: "credential_data" as const,
      data: { access_token: "tok" },
    }));

    const credStore = createMockCredStore();
    const apiClient = createMockApiClient();

    await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      credStore,
      provider,
      apiClient,
      testTagName,
    );

    expect(credStore.set).toHaveBeenCalledWith(
      "user-001",
      "gmailOAuth2Api",
      "p1p3s-cred-123",
    );
  });

  test("provider mode: credential_data without apiClient reports missing", async () => {
    const provider = createMockCredProvider(async () => ({
      status: "credential_data" as const,
      data: { access_token: "tok" },
    }));

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      null,
      provider,
      null,
      testTagName,
    );

    expect(res.missingConnections.length).toBeGreaterThan(0);
    expect(res.missingConnections[0].credType).toBe("gmailOAuth2Api");
    expect(res.injectedCredentials.size).toBe(0);
  });

  test("provider mode: credential_data with apiClient failure reports missing", async () => {
    const provider = createMockCredProvider(async () => ({
      status: "credential_data" as const,
      data: { access_token: "tok" },
    }));

    const apiClient = createMockApiClient({
      createCredential: mock(() => Promise.reject(new Error("workflow API down"))),
    });

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      null,
      provider,
      apiClient,
      testTagName,
    );

    expect(res.missingConnections.length).toBeGreaterThan(0);
    expect(res.missingConnections[0].credType).toBe("gmailOAuth2Api");
  });

  // --------------------------------------------------------------------------
  // External provider mode — needs_auth
  // --------------------------------------------------------------------------

  test("provider mode: returns authUrl when needs_auth", async () => {
    const provider = createMockCredProvider(async () => ({
      status: "needs_auth" as const,
      authUrl: "https://auth.example.com/connect",
    }));

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      null,
      provider,
      null,
      testTagName,
    );
    expect(res.missingConnections.length).toBeGreaterThan(0);
    expect(res.missingConnections[0].authUrl).toBe(
      "https://auth.example.com/connect",
    );
  });

  // --------------------------------------------------------------------------
  // External provider mode — edge cases
  // --------------------------------------------------------------------------

  test("provider mode: falls back to missing on null result", async () => {
    const provider = createMockCredProvider(async () => null);

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      null,
      provider,
      null,
      testTagName,
    );
    expect(res.missingConnections.length).toBeGreaterThan(0);
    expect(res.missingConnections[0].authUrl).toBeUndefined();
  });

  test("provider mode: falls back to missing on provider error", async () => {
    const provider = createMockCredProvider(async () => {
      throw new Error("Provider exploded");
    });

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      baseConfig,
      null,
      provider,
      null,
      testTagName,
    );
    expect(res.missingConnections.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Resolution priority
  // --------------------------------------------------------------------------

  test("priority: db > config > provider", async () => {
    const credStore = createMockCredStore({
      get: mock(() => Promise.resolve("db-wins")),
    });
    const config: WorkflowPluginConfig = {
      ...baseConfig,
      credentials: { gmailOAuth2Api: "config-loses" },
    };
    const provider = createMockCredProvider(async () => ({
      status: "credential_data" as const,
      data: { access_token: "provider-loses" },
    }));

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      config,
      credStore,
      provider,
      null,
      testTagName,
    );
    expect(res.injectedCredentials.get("gmailOAuth2Api")).toBe("db-wins");
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  test("priority: config > provider when db returns null", async () => {
    const credStore = createMockCredStore();
    const config: WorkflowPluginConfig = {
      ...baseConfig,
      credentials: { gmailOAuth2Api: "config-wins" },
    };
    const provider = createMockCredProvider(async () => ({
      status: "credential_data" as const,
      data: { access_token: "provider-loses" },
    }));

    const res = await resolveCredentials(
      createValidWorkflow(),
      "user-001",
      config,
      credStore,
      provider,
      null,
      testTagName,
    );
    expect(res.injectedCredentials.get("gmailOAuth2Api")).toBe("config-wins");
    expect(provider.resolve).not.toHaveBeenCalled();
  });
});
