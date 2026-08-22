/**
 * Deterministic contract tests for the Kimi Code and Grok Build subscription
 * descriptors, local OAuth probes, billing isolation, typed failures, and the
 * pre-workspace Kimi execution-policy boundary.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";
import {
  assertSubscriptionCodingAdapterReady,
  classifySubscriptionRuntimeFailure,
  probeSubscriptionCodingAdapter,
  SUBSCRIPTION_CODING_ADAPTERS,
  SubscriptionCodingAdapterError,
  stripSubscriptionApiEnvironment,
} from "../services/subscription-coding-adapters.js";
import {
  KNOWN_ADAPTER_TYPES,
  normalizeTaskAgentAdapter,
} from "../services/task-agent-routing.js";
import {
  createSubscriptionExecutionAuthorization,
  SUBSCRIPTION_EXECUTION_AUTHORIZATION_METADATA_KEY,
} from "../services/types.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix = "subscription-adapter-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function executable(root: string, name: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(file, 0o755);
  return bin;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
}

function writeManagedKimiLogin(
  kimiHome: string,
  credentials: Record<string, unknown>,
): void {
  mkdirSync(kimiHome, { recursive: true });
  writeFileSync(
    join(kimiHome, "config.toml"),
    [
      'default_model = "kimi-code/kimi-for-coding"',
      "",
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      'base_url = "https://api.kimi.com/coding/v1"',
      'api_key = ""',
      "",
      '[providers."managed:kimi-code".oauth]',
      'storage = "file"',
      'key = "oauth/kimi-code"',
      "",
      '[models."kimi-code/kimi-for-coding"]',
      'provider = "managed:kimi-code"',
      'model = "kimi-for-coding"',
      "max_context_size = 262144",
      "",
    ].join("\n"),
    "utf8",
  );
  writeJson(join(kimiHome, "credentials", "kimi-code.json"), credentials);
}

function grokOidcRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: "session-token",
    auth_mode: "oidc",
    create_time: "2098-12-01T00:00:00.000Z",
    user_id: "subscription-user",
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRuntime(
  settings: Record<string, string> = {},
): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000024096",
    character: { name: "Subscription adapter tester" },
    getSetting: (key: string) => settings[key],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError() {},
    getService: () => null,
  };
}

describe("subscription coding adapter descriptors", () => {
  it("declares only documented CLI and ACP commands", () => {
    expect(SUBSCRIPTION_CODING_ADAPTERS.kimi).toMatchObject({
      defaultAcpCommand: "kimi acp",
      loginCommands: [{ mode: "device", command: "kimi login" }],
      requiresUserAttended: true,
      billingSource: { kind: "included-plan" },
    });
    expect(SUBSCRIPTION_CODING_ADAPTERS.kimi.statusCommand).toBeUndefined();
    expect(SUBSCRIPTION_CODING_ADAPTERS.kimi.logoutCommand).toBeUndefined();
    expect(SUBSCRIPTION_CODING_ADAPTERS.kimi.logoutInstructions).toContain(
      "/logout",
    );

    expect(SUBSCRIPTION_CODING_ADAPTERS.grok).toMatchObject({
      defaultAcpCommand: "grok agent stdio",
      statusCommand: "grok models",
      logoutCommand: "grok logout",
      requiresUserAttended: false,
      billingSource: { kind: "included-plan" },
    });
    expect(SUBSCRIPTION_CODING_ADAPTERS.grok.loginCommands).toEqual([
      { mode: "browser", command: "grok login" },
      { mode: "device", command: "grok login --device-auth" },
    ]);
  });

  it("normalizes user-facing Kimi and Grok adapter aliases", () => {
    expect(normalizeTaskAgentAdapter("Kimi Code")).toBe("kimi");
    expect(normalizeTaskAgentAdapter("moonshot")).toBe("kimi");
    expect(normalizeTaskAgentAdapter("Grok Build")).toBe("grok");
    expect(normalizeTaskAgentAdapter("x-ai")).toBe("grok");
    expect(KNOWN_ADAPTER_TYPES.has("kimi")).toBe(true);
    expect(KNOWN_ADAPTER_TYPES.has("grok")).toBe(true);
  });
});

describe("subscription coding adapter probes", () => {
  it("recognizes a refreshable Kimi Code OAuth login without exposing tokens", () => {
    const root = tempRoot();
    const bin = executable(root, "kimi");
    const kimiHome = join(root, "kimi-home");
    writeManagedKimiLogin(kimiHome, {
      access_token: "secret-access-token",
      refresh_token: "secret-refresh-token",
      expires_at: 1,
    });

    const probe = probeSubscriptionCodingAdapter("kimi", {
      env: { PATH: bin, KIMI_CODE_HOME: kimiHome },
      executionMode: "user-attended",
      homeDir: root,
      nowMs: 2_000,
      platform: "linux",
      transportMode: "native",
    });

    expect(probe).toMatchObject({
      status: "ready",
      installed: true,
      authenticated: true,
      spawnable: true,
      billingSource: { kind: "included-plan" },
    });
    expect(JSON.stringify(probe)).not.toContain("secret-access-token");
    expect(JSON.stringify(probe)).not.toContain("secret-refresh-token");
  });

  it("distinguishes expired Kimi auth from a missing runtime", () => {
    const root = tempRoot();
    const bin = executable(root, "kimi");
    const kimiHome = join(root, "kimi-home");
    writeManagedKimiLogin(kimiHome, {
      access_token: "expired-token",
      expires_at: 1,
    });

    expect(
      probeSubscriptionCodingAdapter("kimi", {
        env: { PATH: bin, KIMI_CODE_HOME: kimiHome },
        homeDir: root,
        nowMs: 2_000,
        platform: "linux",
      }).status,
    ).toBe("auth-expired");
    expect(
      probeSubscriptionCodingAdapter("kimi", {
        env: { PATH: "", KIMI_CODE_HOME: kimiHome },
        homeDir: root,
        platform: "linux",
      }).status,
    ).toBe("runtime-missing");
  });

  it("accepts Grok OAuth state but never treats a direct API key as a subscription", () => {
    const root = tempRoot();
    const bin = executable(root, "grok");
    const grokHome = join(root, "grok-home");
    writeJson(join(grokHome, "auth.json"), {
      "xai::api_key": {
        key: "payg-key",
        auth_mode: "api_key",
        create_time: "2098-12-01T00:00:00.000Z",
        user_id: "",
      },
    });

    expect(
      probeSubscriptionCodingAdapter("grok", {
        env: { PATH: bin, GROK_HOME: grokHome, XAI_API_KEY: "payg-env" },
        homeDir: root,
        platform: "linux",
      }).status,
    ).toBe("auth-required");

    writeJson(join(grokHome, "auth.json"), {
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":
        grokOidcRecord(),
      "xai::api_key": {
        key: "payg-key",
        auth_mode: "api_key",
        create_time: "2098-12-01T00:00:00.000Z",
        user_id: "",
      },
    });
    expect(
      probeSubscriptionCodingAdapter("grok", {
        env: { PATH: bin, GROK_HOME: grokHome },
        homeDir: root,
        platform: "linux",
      }),
    ).toMatchObject({ status: "ready", authenticated: true });
  });

  it("rejects incomplete and legacy Grok records exactly as the CLI does", () => {
    const root = tempRoot();
    const bin = executable(root, "grok");
    const grokHome = join(root, "grok-home");
    const probe = () =>
      probeSubscriptionCodingAdapter("grok", {
        env: { PATH: bin, GROK_HOME: grokHome },
        homeDir: root,
        platform: "linux",
      });

    writeJson(join(grokHome, "auth.json"), {
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: "token-without-required-record-fields",
        auth_mode: "oidc",
      },
    });
    expect(probe().status).toBe("auth-required");

    writeJson(join(grokHome, "auth.json"), {
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": grokOidcRecord(
        { auth_mode: "grok" },
      ),
    });
    expect(probe().status).toBe("auth-required");
  });

  it("rejects a Kimi default model that could bill a direct provider", () => {
    const root = tempRoot();
    const bin = executable(root, "kimi");
    const kimiHome = join(root, "kimi-home");
    writeManagedKimiLogin(kimiHome, {
      access_token: "oauth-token-that-must-not-mask-config",
    });
    writeFileSync(
      join(kimiHome, "config.toml"),
      [
        'default_model = "direct/model"',
        "",
        '[providers."direct"]',
        'type = "openai_legacy"',
        'base_url = "https://api.moonshot.ai/v1"',
        'api_key = "direct-billing-key"',
        "",
        '[models."direct/model"]',
        'provider = "direct"',
        'model = "kimi-k2"',
      ].join("\n"),
      "utf8",
    );

    expect(
      probeSubscriptionCodingAdapter("kimi", {
        env: { PATH: bin, KIMI_CODE_HOME: kimiHome },
        executionMode: "user-attended",
        homeDir: root,
        platform: "linux",
      }).status,
    ).toBe("billing-conflict");
  });

  it("returns typed unsupported-platform and native-transport failures", () => {
    const platform = probeSubscriptionCodingAdapter("grok", {
      platform: "aix",
    });
    const transport = probeSubscriptionCodingAdapter("grok", {
      platform: "linux",
      transportMode: "cli",
    });

    expect(platform.status).toBe("platform-unsupported");
    expect(transport.status).toBe("transport-unsupported");
  });
});

describe("subscription billing and error isolation", () => {
  it("strips direct API settings while preserving subscription homes", () => {
    const kimiEnv = {
      KIMI_CODE_HOME: "/tmp/kimi-home",
      KIMI_API_KEY: "payg",
      KIMI_CODING_API_KEY: "endpoint-key",
      KIMI_CODING_BASE_URL: "https://api.kimi.com/coding/v1",
      KIMI_MODEL_NAME: "direct/model",
      KIMI_MODEL_API_KEY: "model-payg",
      KIMI_CODE_CUSTOM_HEADERS: '{"Authorization":"Bearer payg"}',
      MOONSHOT_API_KEY: "payg",
      PATH: "/bin",
    };
    const grokEnv = {
      GROK_HOME: "/tmp/grok-home",
      XAI_API_KEY: "payg",
      GROK_API_KEY: "payg-alias",
      GROK_AUTH: '{"key":"inline-override"}',
      GROK_AUTH_PATH: "/tmp/attacker/auth.json",
      XAI_BASE_URL: "https://api.x.ai/v1",
      PATH: "/bin",
    };

    expect(stripSubscriptionApiEnvironment("kimi", kimiEnv)).toEqual([
      "KIMI_API_KEY",
      "KIMI_CODING_API_KEY",
      "MOONSHOT_API_KEY",
      "KIMI_CODING_BASE_URL",
      "KIMI_CODE_CUSTOM_HEADERS",
      "KIMI_MODEL_NAME",
      "KIMI_MODEL_API_KEY",
    ]);
    expect(stripSubscriptionApiEnvironment("grok", grokEnv)).toEqual([
      "XAI_API_KEY",
      "GROK_API_KEY",
      "XAI_BASE_URL",
      "GROK_AUTH",
      "GROK_AUTH_PATH",
    ]);
    expect(kimiEnv).toEqual({ KIMI_CODE_HOME: "/tmp/kimi-home", PATH: "/bin" });
    expect(grokEnv).toEqual({ GROK_HOME: "/tmp/grok-home", PATH: "/bin" });
  });

  it("classifies revoked login and included-plan quota failures", () => {
    expect(
      classifySubscriptionRuntimeFailure(
        "grok",
        new Error("401 unauthorized: token revoked"),
      ),
    ).toMatchObject({
      code: "CODING_SUBSCRIPTION_LOGIN_REVOKED",
      adapterId: "grok",
    });
    expect(
      classifySubscriptionRuntimeFailure(
        "kimi",
        new Error("429 usage limit exceeded"),
      ),
    ).toMatchObject({
      code: "CODING_SUBSCRIPTION_QUOTA_EXHAUSTED",
      adapterId: "kimi",
    });
  });

  it("applies API-key stripping at the AcpService child-env boundary", () => {
    vi.stubEnv("ELIZA_MODEL_GATEWAY_URL", "https://gateway.example.test");
    vi.stubEnv("ELIZA_MODEL_GATEWAY_TOKEN", "parent-gateway-secret");
    const service = new AcpService(makeRuntime() as never);
    const buildEnv = (
      service as unknown as {
        buildEnv: (
          extra: Record<string, string>,
          customCredentials: Record<string, string>,
          model: string | undefined,
          agentType: string,
        ) => NodeJS.ProcessEnv;
      }
    ).buildEnv.bind(service);

    const kimiEnv = buildEnv(
      {
        KIMI_CODE_HOME: "/tmp/kimi-home",
        KIMI_API_KEY: "payg",
        KIMI_CODING_API_KEY: "pooled-endpoint-key",
        KIMI_MODEL_NAME: "direct/model",
        KIMI_MODEL_API_KEY: "model-payg",
        KIMI_CODE_CUSTOM_HEADERS: '{"Authorization":"Bearer payg"}',
      },
      {
        MOONSHOT_API_KEY: "payg",
        KIMI_CODING_BASE_URL: "https://api.kimi.com/coding/v1",
      },
      undefined,
      "kimi",
    );
    const grokEnv = buildEnv(
      {
        GROK_HOME: "/tmp/grok-home",
        XAI_API_KEY: "payg",
        GROK_API_KEY: "payg-alias",
        GROK_AUTH: '{"key":"inline-override"}',
        GROK_AUTH_PATH: "/tmp/attacker/auth.json",
      },
      { ELIZA_XAI_API_KEY: "payg", XAI_BASE_URL: "https://api.x.ai/v1" },
      undefined,
      "grok",
    );

    expect(kimiEnv.KIMI_CODE_HOME).toBe("/tmp/kimi-home");
    expect(kimiEnv.KIMI_API_KEY).toBeUndefined();
    expect(kimiEnv.KIMI_CODING_API_KEY).toBeUndefined();
    expect(kimiEnv.KIMI_CODING_BASE_URL).toBeUndefined();
    expect(kimiEnv.KIMI_MODEL_NAME).toBeUndefined();
    expect(kimiEnv.KIMI_MODEL_API_KEY).toBeUndefined();
    expect(kimiEnv.KIMI_CODE_CUSTOM_HEADERS).toBeUndefined();
    expect(kimiEnv.MOONSHOT_API_KEY).toBeUndefined();
    expect(kimiEnv.OPENAI_API_KEY).toBeUndefined();
    expect(kimiEnv.ELIZA_MODEL_GATEWAY_URL).toBeUndefined();
    expect(kimiEnv.ELIZA_MODEL_GATEWAY_TOKEN).toBeUndefined();
    expect(kimiEnv.ANTHROPIC_API_KEY).not.toBe("parent-gateway-secret");
    expect(grokEnv.GROK_HOME).toBe("/tmp/grok-home");
    expect(grokEnv.XAI_API_KEY).toBeUndefined();
    expect(grokEnv.GROK_API_KEY).toBeUndefined();
    expect(grokEnv.GROK_AUTH).toBeUndefined();
    expect(grokEnv.GROK_AUTH_PATH).toBeUndefined();
    expect(grokEnv.XAI_BASE_URL).toBeUndefined();
    expect(grokEnv.ELIZA_XAI_API_KEY).toBeUndefined();
    expect(grokEnv.ELIZA_MODEL_GATEWAY_URL).toBeUndefined();
    expect(grokEnv.ELIZA_MODEL_GATEWAY_TOKEN).toBeUndefined();
    expect(grokEnv.OPENAI_API_KEY).not.toBe("parent-gateway-secret");
    expect(grokEnv.ANTHROPIC_API_KEY).not.toBe("parent-gateway-secret");
  });

  it("pins the probed account home into the child and disables Grok API-key fallback", () => {
    const service = new AcpService(
      makeRuntime({
        KIMI_CODE_HOME: "/tenant-a/kimi",
        GROK_HOME: "/tenant-a/grok",
      }) as never,
    );
    const buildEnv = (
      service as unknown as {
        buildEnv: (
          extra: Record<string, string>,
          customCredentials: Record<string, string>,
          model: string | undefined,
          agentType: string,
        ) => NodeJS.ProcessEnv;
      }
    ).buildEnv.bind(service);

    const kimiEnv = buildEnv(
      { KIMI_CODE_HOME: "/caller-controlled/kimi" },
      {},
      undefined,
      "kimi",
    );
    const grokEnv = buildEnv(
      {
        GROK_HOME: "/caller-controlled/grok",
        GROK_DISABLE_API_KEY_AUTH: "0",
        GROK_AUTH_PATH: "/caller-controlled/auth.json",
        GROK_AUTH: '{"key":"inline-override"}',
      },
      { XAI_API_KEY: "payg-must-not-win" },
      undefined,
      "grok",
    );

    expect(kimiEnv.KIMI_CODE_HOME).toBe("/tenant-a/kimi");
    expect(grokEnv.GROK_HOME).toBe("/tenant-a/grok");
    expect(grokEnv.GROK_DISABLE_API_KEY_AUTH).toBe("1");
    expect(grokEnv.GROK_AUTH_PATH).toBeUndefined();
    expect(grokEnv.GROK_AUTH).toBeUndefined();
    expect(grokEnv.XAI_API_KEY).toBeUndefined();
  });

  it("surfaces billing source and execution policy in agent inventory", async () => {
    const service = new AcpService(makeRuntime() as never);
    const available = await service.getAvailableAgents();

    expect(available.find((agent) => agent.agentType === "kimi")).toMatchObject(
      {
        billingSource: {
          kind: "included-plan",
          label: "Kimi Code included plan",
        },
        executionPolicy: { requiresUserAttended: true },
      },
    );
    expect(available.find((agent) => agent.agentType === "grok")).toMatchObject(
      {
        billingSource: { kind: "included-plan", label: "Grok included plan" },
        executionPolicy: { requiresUserAttended: false },
      },
    );
  });
});

describe("Kimi user-attended spawn policy", () => {
  it("persists interactive attendance proof on the durable session", async () => {
    const root = tempRoot("kimi-attended-");
    const bin = executable(root, "kimi");
    const kimiHome = join(root, "kimi-home");
    const workspaceRoot = join(root, "workspaces");
    writeManagedKimiLogin(kimiHome, {
      access_token: "valid-oauth-token",
      expires_at: 4_070_908_800,
    });
    const store = new InMemorySessionStore();
    const service = new AcpService(
      makeRuntime({
        ELIZA_ACP_WORKSPACE_ROOT: workspaceRoot,
        ELIZA_KIMI_ACP_COMMAND: join(bin, "kimi"),
        KIMI_CODE_HOME: kimiHome,
      }) as never,
      { store },
    );
    (service as unknown as { started: boolean }).started = true;
    (
      service as unknown as {
        spawnNativeSession: (
          id: string,
          session: {
            name?: string;
            agentType: string;
            workdir: string;
            status: string;
            metadata?: Record<string, unknown>;
          },
        ) => Promise<Record<string, unknown>>;
      }
    ).spawnNativeSession = async (id, session) => ({
      sessionId: id,
      id,
      name: session.name ?? id,
      agentType: session.agentType,
      workdir: session.workdir,
      status: session.status,
      metadata: session.metadata,
    });
    const authorization = createSubscriptionExecutionAuthorization(
      "interactive-http",
      "request-24096",
    );

    await service.spawnSession({
      agentType: "kimi",
      workdir: workspaceRoot,
      subscriptionExecutionAuthorization: authorization,
      env: {
        KIMI_MODEL_NAME: "direct/model",
        KIMI_MODEL_API_KEY: "must-not-override-managed-oauth",
      },
    });

    const [persisted] = await store.list();
    expect(
      persisted?.metadata?.[SUBSCRIPTION_EXECUTION_AUTHORIZATION_METADATA_KEY],
    ).toEqual(authorization);

    const recoverySpawn = vi.fn(async () => ({
      sessionId: "recovered-session",
      id: "recovered-session",
      name: "recovered-session",
      agentType: "kimi",
      workdir: workspaceRoot,
      status: "ready",
    }));
    service.spawnSession = recoverySpawn as never;
    await service.reattachSession(persisted?.id ?? "missing-session");
    expect(recoverySpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionExecutionAuthorization: authorization,
      }),
    );
  });

  it("fails unattended Kimi before creating a workspace or durable task", async () => {
    const root = tempRoot("kimi-unattended-");
    const store = new InMemorySessionStore();
    const service = new AcpService(
      makeRuntime({ ELIZA_ACP_WORKSPACE_ROOT: root }) as never,
      { store },
    );
    (service as unknown as { started: boolean }).started = true;

    let refusal: unknown;
    try {
      await service.spawnSession({
        agentType: "kimi",
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(SubscriptionCodingAdapterError);
    expect(refusal).toMatchObject({
      code: "CODING_SUBSCRIPTION_EXECUTION_POLICY_BLOCKED",
      adapterId: "kimi",
    });
    expect(String((refusal as Error).message)).toContain("user-attended");
    expect(readdirSync(root)).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it("also rejects an unspecified execution mode instead of assuming attendance", () => {
    expect(() =>
      assertSubscriptionCodingAdapterReady("kimi", {
        executionMode: undefined,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CODING_SUBSCRIPTION_EXECUTION_POLICY_BLOCKED",
      }),
    );
  });
});
