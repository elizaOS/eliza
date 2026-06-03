import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

type ViewportCase = {
  name: string;
  width: number;
  height: number;
};

const VIEWPORTS: ViewportCase[] = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "wide-web", width: 1440, height: 900 },
];

const CLOUD_AUTH_TOKEN = "ui-smoke-cloud-auth-token";
const VOICE_PREFIX_DONE_STORAGE_KEY = "eliza:voice:prefix-done";

type DirectCloudSandboxRouteState = {
  createRequests: number;
  provisionRequests: number;
  jobPollRequests: number;
};

type FirstRunSubmitPayload = {
  deploymentTarget?: {
    runtime?: string;
    provider?: string;
  };
};

type FirstRunRouteState = {
  complete: boolean;
  submissions: FirstRunSubmitPayload[];
};

type DeterministicAssistantFixture = {
  fixture: string;
  transport: string;
  input: {
    text: string;
  };
};

function apiBaseFromTest(baseURL: string | undefined): string {
  expect(baseURL, "Playwright baseURL must be configured").toBeTruthy();
  return (baseURL ?? "").replace(/\/$/, "");
}

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function clickIfVisible(
  locator: Locator,
  timeoutMs = 2_000,
): Promise<boolean> {
  const target = locator.first();
  try {
    await target.waitFor({ state: "visible", timeout: timeoutMs });
    await target.click({ timeout: timeoutMs });
  } catch {
    return false;
  }
  return true;
}

async function startCloudRuntime(page: Page): Promise<void> {
  await clickIfVisible(page.getByRole("button", { name: "Get started" }));
  const startButton = page.getByRole("button", { name: /^Start$/ });
  if (await clickIfVisible(startButton, 30_000)) {
    return;
  }

  const compactCloudButton = page
    .getByTestId("onboarding-toast")
    .getByRole("button", { name: /^Eliza Cloud$/ });
  if (await clickIfVisible(compactCloudButton, 10_000)) {
    // Current compact onboarding may use the first cloud click to complete or
    // refresh cloud auth state. If the toast is still actionable, click again to
    // start provisioning with the now-connected cloud session.
    await clickIfVisible(compactCloudButton, 15_000);
    return;
  }

  const connectButton = page.getByRole("button", { name: /^Connect$/ });
  if (await clickIfVisible(connectButton, 10_000)) {
    if (await clickIfVisible(startButton, 30_000)) {
      return;
    }
    return;
  }

  throw new Error("Cloud runtime did not show a Start or cloud selection action");
}

async function installCloudConnectionRoutes(
  page: Page,
  userId: string,
): Promise<void> {
  await page.unroute("**/api/cloud/status").catch(() => {});
  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      connected: true,
      enabled: true,
      cloudVoiceProxyAvailable: true,
      hasApiKey: true,
      userId,
    });
  });

  await page.unroute("**/api/cloud/credits").catch(() => {});
  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      balance: 100,
      low: false,
      critical: false,
      authRejected: false,
    });
  });
}

async function installDirectCloudSandboxRoutes(
  page: Page,
  options: {
    apiBase: string;
    agentId: string;
    jobId: string;
    state: DirectCloudSandboxRouteState;
  },
): Promise<void> {
  await page.route(
    "https://api.elizacloud.ai/api/v1/eliza/agents",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      options.state.createRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: { id: options.agentId },
      });
    },
  );

  await page.route(
    `https://api.elizacloud.ai/api/v1/eliza/agents/${options.agentId}/provision`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      options.state.provisionRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: { jobId: options.jobId },
      });
    },
  );

  await page.route(
    `https://api.elizacloud.ai/api/v1/jobs/${options.jobId}`,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      options.state.jobPollRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: {
          status: "completed",
          result: { bridgeUrl: options.apiBase },
        },
      });
    },
  );
}

async function installDirectCloudLoginRoutes(
  page: Page,
  userId: string,
): Promise<void> {
  await page.route("**/api/cloud/login", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      ok: true,
      sessionId: "ui-smoke-cloud-session",
      browserUrl: "https://www.elizacloud.ai/device/ui-smoke-cloud-session",
    });
  });

  await page.route("**/api/cloud/login/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      status: "authenticated",
      token: CLOUD_AUTH_TOKEN,
      organizationId: "ui-smoke-org",
      userId,
    });
  });

  await page.route(
    "https://api.elizacloud.ai/api/auth/cli-session",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, { ok: true });
    },
  );

  await page.route(
    "https://api.elizacloud.ai/api/auth/cli-session/**",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        status: "authenticated",
        apiKey: CLOUD_AUTH_TOKEN,
        organizationId: "ui-smoke-org",
        userId,
      });
    },
  );
}

async function installFirstRunSubmitRoute(
  page: Page,
  state: FirstRunRouteState,
): Promise<void> {
  await page.route("**/api/first-run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const payload = route.request().postDataJSON() as FirstRunSubmitPayload;
    expect(payload).toMatchObject({
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
    });
    state.submissions.push(payload);
    state.complete = true;
    await fulfillJson(route, 200, { ok: true });
  });
}

function parseAssistantFixtureText(
  text: string,
): DeterministicAssistantFixture {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  expect(start, "Assistant message should contain JSON").toBeGreaterThanOrEqual(
    0,
  );
  expect(end, "Assistant message should contain complete JSON").toBeGreaterThan(
    start,
  );
  return JSON.parse(
    text.slice(start, end + 1),
  ) as DeterministicAssistantFixture;
}

async function expectDeterministicChatTurn(
  page: Page,
  prompt: string,
): Promise<void> {
  await expect(
    page
      .locator('[data-testid="chat-message"][data-role="user"]')
      .filter({ hasText: prompt })
      .last(),
  ).toBeVisible();
  const assistantMessage = page
    .locator('[data-testid="chat-message"][data-role="assistant"]')
    .last();
  await expect(assistantMessage).toBeVisible();
  const assistantText = (await assistantMessage.textContent())?.trim() ?? "";
  const parsed = parseAssistantFixtureText(assistantText);
  expect(parsed).toMatchObject({
    fixture: "ui-smoke-assistant-v1",
    transport: "sse",
    input: {
      text: prompt,
    },
  });
}

for (const viewport of VIEWPORTS) {
  test(`cloud provisioning reaches chat from startup on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    const apiBase = apiBaseFromTest(baseURL);
    const directCloudState: DirectCloudSandboxRouteState = {
      createRequests: 0,
      provisionRequests: 0,
      jobPollRequests: 0,
    };
    const firstRunState: FirstRunRouteState = {
      complete: false,
      submissions: [],
    };
    let _provisionRequests = 0;
    let _jobPollRequests = 0;
    let _agentDetailRequests = 0;
    let _launchRequests = 0;

    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.addInitScript(
      ({ cloudAuthToken, voicePrefixDoneKey }) => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem(voicePrefixDoneKey, "1");
        (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
          cloudAuthToken;
      },
      {
        cloudAuthToken: CLOUD_AUTH_TOKEN,
        voicePrefixDoneKey: VOICE_PREFIX_DONE_STORAGE_KEY,
      },
    );

    await installDefaultAppRoutes(page);
    await installCloudConnectionRoutes(page, "cloud-provisioning-smoke-user");
    await installDirectCloudLoginRoutes(page, "cloud-provisioning-smoke-user");
    await installDirectCloudSandboxRoutes(page, {
      apiBase,
      agentId: "agent-1",
      jobId: "job-1",
      state: directCloudState,
    });
    await installFirstRunSubmitRoute(page, firstRunState);

    await page.route("**/api/auth/status", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        required: false,
        authenticated: true,
        loginRequired: false,
        localAccess: true,
        passwordConfigured: false,
        pairingEnabled: false,
        expiresAt: null,
      });
    });

    await page.route("**/api/first-run/status", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        complete: firstRunState.complete,
        cloudProvisioned: firstRunState.complete,
      });
    });

    await page.route("**/api/cloud/status", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        connected: true,
        enabled: true,
        cloudVoiceProxyAvailable: true,
        hasApiKey: true,
        userId: "cloud-provisioning-smoke-user",
      });
    });

    await page.route("**/api/cloud/credits", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        balance: 100,
        low: false,
        critical: false,
        authRejected: false,
      });
    });

    await page.route("**/api/cloud/compat/agents", async (route) => {
      const request = route.request();
      if (request.method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        success: true,
        data: [
          {
            agent_id: "agent-1",
            agent_name: "My Agent",
            status: "stopped",
            bridge_url: null,
            web_ui_url: null,
            containerUrl: "",
            webUiUrl: null,
            database_status: "ready",
            error_message: null,
            agent_config: {},
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            last_heartbeat_at: null,
          },
        ],
      });
    });

    await page.route(
      "**/api/cloud/v1/eliza/agents/agent-1/provision",
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        _provisionRequests += 1;
        await fulfillJson(route, 202, {
          success: true,
          data: {
            jobId: "job-1",
            agentId: "agent-1",
            status: "pending",
          },
          polling: {
            endpoint: "/api/cloud/compat/jobs/job-1",
            intervalMs: 5000,
            expectedDurationMs: 90000,
          },
        });
      },
    );

    await page.route("**/api/cloud/compat/jobs/job-1", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      _jobPollRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: {
          id: "job-1",
          jobId: "job-1",
          type: "agent_provision",
          status: "completed",
          data: {},
          result: {
            agentId: "agent-1",
            status: "running",
            bridgeUrl: apiBase,
          },
          error: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
          retryCount: 0,
          name: "agent_provision",
          state: "completed",
          created_on: "2026-01-01T00:00:00.000Z",
          completed_on: "2026-01-01T00:00:02.000Z",
        },
      });
    });

    await page.route("**/api/cloud/compat/agents/agent-1", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      _agentDetailRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: {
          agent_id: "agent-1",
          agent_name: "My Agent",
          status: "running",
          bridge_url: apiBase,
          web_ui_url: null,
          containerUrl: "",
          webUiUrl: null,
          database_status: "ready",
          error_message: null,
          agent_config: {},
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:02.000Z",
          last_heartbeat_at: "2026-01-01T00:00:02.000Z",
        },
      });
    });

    const fulfillLaunch = async (route: Route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      _launchRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: {
          agentId: "agent-1",
          agentName: "My Agent",
          appUrl: apiBase,
          launchSessionId: "launch-1",
          issuedAt: "2026-01-01T00:00:02.000Z",
          connection: {
            apiBase,
            token: "agent-token",
          },
        },
      });
    };

    await page.route(
      "**/api/cloud/compat/agents/agent-1/launch",
      fulfillLaunch,
    );
    await page.route("**/api/compat/agents/agent-1/launch", fulfillLaunch);

    await page.route(
      "**/api/cloud/v1/app/agents/agent-1/launch",
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        await fulfillJson(route, 200, {
          success: true,
          data: {
            agentId: "agent-1",
            agentName: "My Agent",
            appUrl:
              "https://app.elizacloud.ai/?cloudLaunchSession=launch-1&cloudLaunchBase=https%3A%2F%2Fapi.elizacloud.ai",
            launchSessionId: "launch-1",
            issuedAt: "2026-01-01T00:00:02.000Z",
            connection: {
              apiBase,
              token: "agent-token",
            },
          },
        });
      },
    );

    await openAppPath(page, "/chat");
    await startCloudRuntime(page);
    await clickIfVisible(
      page.getByRole("button", { name: /sign in with eliza cloud/i }),
    );

    await expect.poll(() => directCloudState.createRequests).toBe(1);
    await expect.poll(() => directCloudState.provisionRequests).toBe(1);
    await expect
      .poll(() => directCloudState.jobPollRequests)
      .toBeGreaterThan(0);
    await expect.poll(() => firstRunState.submissions.length).toBe(1);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("elizaos:active-server");
          return raw ? JSON.parse(raw) : null;
        }),
      )
      .toMatchObject({
        id: `cloud:${apiBase}`,
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase,
        accessToken: CLOUD_AUTH_TOKEN,
      });

    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("eliza:mobile-runtime-mode")),
      )
      .toBe("cloud");

    await openAppPath(page, "/chat");
    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();

    const cloudChatPrompt = `cloud provisioning smoke ${viewport.name}`;
    await page.getByTestId("chat-composer-textarea").fill(cloudChatPrompt);
    await page.getByTestId("chat-composer-action").click();

    await expectDeterministicChatTurn(page, cloudChatPrompt);
  });
}

test("new cloud agent provisions through direct cloud sandbox and reaches chat", async ({
  page,
  baseURL,
}) => {
  const apiBase = apiBaseFromTest(baseURL);
  const directCloudState: DirectCloudSandboxRouteState = {
    createRequests: 0,
    provisionRequests: 0,
    jobPollRequests: 0,
  };
  const firstRunState: FirstRunRouteState = {
    complete: false,
    submissions: [],
  };
  let _createRequests = 0;
  let _jobPollRequests = 0;
  let _provisioningChatRequests = 0;
  let _launchRequests = 0;
  let allowHandoff = false;

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(
    ({ cloudAuthToken, voicePrefixDoneKey }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem(voicePrefixDoneKey, "1");
      (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
        cloudAuthToken;
    },
    {
      cloudAuthToken: CLOUD_AUTH_TOKEN,
      voicePrefixDoneKey: VOICE_PREFIX_DONE_STORAGE_KEY,
    },
  );

  await installDefaultAppRoutes(page);
  await installCloudConnectionRoutes(page, "cloud-provisioning-chat-user");
  await installDirectCloudLoginRoutes(page, "cloud-provisioning-chat-user");
  await installDirectCloudSandboxRoutes(page, {
    apiBase,
    agentId: "agent-new",
    jobId: "job-new",
    state: directCloudState,
  });
  await installFirstRunSubmitRoute(page, firstRunState);

  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      required: false,
      authenticated: true,
      loginRequired: false,
      localAccess: true,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });
  });

  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      complete: firstRunState.complete,
      cloudProvisioned: firstRunState.complete,
    });
  });

  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      connected: true,
      enabled: true,
      cloudVoiceProxyAvailable: true,
      hasApiKey: true,
      userId: "cloud-provisioning-chat-user",
    });
  });

  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      balance: 100,
      low: false,
      critical: false,
      authRejected: false,
    });
  });

  await page.route("**/api/cloud/compat/agents", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await fulfillJson(route, 200, {
        success: true,
        data: [],
      });
      return;
    }
    if (request.method() === "POST") {
      _createRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: {
          agentId: "agent-new",
          agentName: "My Agent",
          jobId: "job-new",
          status: "pending",
          nodeId: null,
          message: "Agent created",
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/cloud/compat/jobs/job-new", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    _jobPollRequests += 1;
    await fulfillJson(route, 200, {
      success: true,
      data: {
        id: "job-new",
        jobId: "job-new",
        type: "agent_provision",
        status: allowHandoff ? "completed" : "in_progress",
        data: {},
        result: allowHandoff
          ? {
              agentId: "agent-new",
              status: "running",
              bridgeUrl: apiBase,
            }
          : null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: allowHandoff ? "2026-01-01T00:00:02.000Z" : null,
        retryCount: 0,
        name: "agent_provision",
        state: allowHandoff ? "completed" : "in_progress",
      },
    });
  });

  await page.route("**/api/v1/provisioning-agent", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      success: true,
      data: {
        status: allowHandoff ? "running" : "provisioning",
        agentId: "agent-new",
        ...(allowHandoff ? { bridgeUrl: apiBase } : {}),
      },
    });
  });

  await page.route("**/api/v1/provisioning-agent/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    _provisioningChatRequests += 1;
    const body = await route.request().postDataJSON();
    expect(body).toMatchObject({
      message: "my name is Shaw and I want Discord",
      agentId: "agent-new",
    });
    allowHandoff = true;
    await fulfillJson(route, 200, {
      success: true,
      data: {
        reply:
          "Got it. I will remember your name and that Discord is a priority.",
        containerStatus: "running",
        bridgeUrl: apiBase,
        history: [
          { role: "user", content: body.message },
          {
            role: "assistant",
            content:
              "Got it. I will remember your name and that Discord is a priority.",
          },
        ],
      },
    });
  });

  await page.route("**/api/cloud/compat/agents/agent-new", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      success: true,
      data: {
        agent_id: "agent-new",
        agent_name: "My Agent",
        status: "running",
        bridge_url: apiBase,
        web_ui_url: null,
        containerUrl: "",
        webUiUrl: null,
        database_status: "ready",
        error_message: null,
        agent_config: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:02.000Z",
        last_heartbeat_at: "2026-01-01T00:00:02.000Z",
      },
    });
  });

  const fulfillLaunch = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    _launchRequests += 1;
    await fulfillJson(route, 200, {
      success: true,
      data: {
        agentId: "agent-new",
        agentName: "My Agent",
        appUrl: apiBase,
        launchSessionId: "launch-new",
        issuedAt: "2026-01-01T00:00:02.000Z",
        connection: {
          apiBase,
          token: "agent-token",
        },
      },
    });
  };

  await page.route(
    "**/api/cloud/compat/agents/agent-new/launch",
    fulfillLaunch,
  );
  await page.route("**/api/compat/agents/agent-new/launch", fulfillLaunch);
  await page.route(
    "**/api/cloud/v1/app/agents/agent-new/launch",
    fulfillLaunch,
  );

  await openAppPath(page, "/chat");
  await startCloudRuntime(page);
  await clickIfVisible(
    page.getByRole("button", { name: /sign in with eliza cloud/i }),
  );

  await expect.poll(() => directCloudState.createRequests).toBe(1);
  await expect.poll(() => directCloudState.provisionRequests).toBe(1);
  await expect.poll(() => directCloudState.jobPollRequests).toBeGreaterThan(0);
  await expect.poll(() => firstRunState.submissions.length).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("elizaos:active-server");
        return raw ? JSON.parse(raw) : null;
      }),
    )
    .toMatchObject({
      id: `cloud:${apiBase}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: CLOUD_AUTH_TOKEN,
    });

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
  await page
    .getByTestId("chat-composer-textarea")
    .fill("my name is Shaw and I want Discord");
  await page.getByTestId("chat-composer-action").click();

  await expectDeterministicChatTurn(page, "my name is Shaw and I want Discord");
});
