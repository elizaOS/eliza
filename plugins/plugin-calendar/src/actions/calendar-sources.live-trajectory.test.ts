/**
 * Live-model trajectory tests for CALENDAR_SOURCES connect handoffs (PR #18050).
 * Gated on ELIZA_LIVE_TEST=1 and a live OpenAI-compatible key. Privacy-safe:
 * OAuth transport is stubbed; auth URLs redacted to host+path in assertions.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CONNECTOR_ACCOUNT_SERVICE_TYPE,
  ConnectorAccountManager,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { CalendarService } from "../service/CalendarService.js";
import { calendarSourcesAction } from "./calendar-sources.js";

const LIVE =
  process.env.ELIZA_LIVE_TEST === "1" &&
  Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.CEREBRAS_API_KEY ||
      process.env.OPENCODE_GO_API_KEY,
  );

const BASE_URL = (
  process.env.OPENAI_BASE_URL ||
  process.env.PI_OPENCODE_GO_BASE_URL ||
  "https://api.openai.com/v1"
).replace(/\/$/, "");
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OPENCODE_GO_API_KEY ||
  process.env.CEREBRAS_API_KEY ||
  "";
const MODEL = process.env.LIVE_MODEL || "gpt-5.4-mini";
const HEAD = process.env.EVIDENCE_HEAD || "unknown";
const OUTDIR =
  process.env.OUTDIR ||
  path.resolve(
    process.cwd(),
    "../../reports/live-test-runs/lean-chat-calendar-trajectories",
  );

const AGENT_ID = "00000000-0000-0000-0000-000000000101";

function userMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000103",
    entityId: AGENT_ID,
    roomId: "00000000-0000-0000-0000-000000000104",
    content: { text, source: "live-trajectory" },
  } as Memory;
}

function runtimeFixture() {
  let manager: ConnectorAccountManager;
  const runtime = {
    agentId: AGENT_ID,
    getService: (serviceType: string) => {
      if (serviceType === CONNECTOR_ACCOUNT_SERVICE_TYPE) return manager;
      if (serviceType === CalendarService.serviceType) return null;
      return null;
    },
    getRoom: async () => null,
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
  } as unknown as IAgentRuntime;
  manager = new ConnectorAccountManager(runtime);
  return { runtime, manager };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "CALENDAR_SOURCES",
      description:
        "Manage calendar sources. Use for connect/link/add/setup Google|Microsoft|Apple calendar. operation=connect with provider=google|microsoft|apple_calendar|ics. Prefer this over CONNECTOR for calendar feed connect.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "list",
              "connect",
              "reconnect",
              "sync",
              "include",
              "exclude",
            ],
          },
          provider: {
            type: "string",
            enum: ["google", "microsoft", "apple_calendar", "ics"],
          },
        },
        required: ["operation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "CONNECTOR",
      description:
        "Generic connector account setup for non-calendar feeds. Do NOT use for Google Calendar connect.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string" },
          connector: { type: "string" },
        },
      },
    },
  },
];

async function livePlan(userText: string) {
  const messages = [
    {
      role: "system",
      content:
        "You are an elizaOS planner. For calendar connect/link/setup requests choose CALENDAR_SOURCES with operation=connect and the exact provider. Never use CONNECTOR for Google Calendar. Call exactly one tool.",
    },
    { role: "user", content: userText },
  ];
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`live model ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    model?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: Record<string, unknown>;
  };
  const choice = json.choices?.[0];
  return {
    provider: "openai-compatible",
    model: json.model || MODEL,
    messages,
    tool_calls: choice?.message?.tool_calls ?? [],
    content: choice?.message?.content ?? null,
    finish_reason: choice?.finish_reason,
    usage: json.usage,
  };
}

const describeLive = LIVE ? describe : describe.skip;

describeLive("CALENDAR_SOURCES live-model trajectories", () => {
  it("configured authorization: live plan → trusted Google auth handoff", async () => {
    mkdirSync(OUTDIR, { recursive: true });
    const userText = "connect google calendar";
    const plan = await livePlan(userText);
    const tool = plan.tool_calls[0];
    expect(tool?.function?.name).toBe("CALENDAR_SOURCES");
    const parameters = JSON.parse(tool?.function?.arguments || "{}") as {
      operation?: string;
      provider?: string;
    };
    expect(parameters.operation).toBe("connect");
    expect(parameters.provider).toBe("google");

    const { runtime, manager } = runtimeFixture();
    manager.registerProvider({
      provider: "google",
      startOAuth: async () => ({
        id: "flow-live-1",
        authUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&scope=calendar.read",
      }),
    });

    const result = await calendarSourcesAction.handler(
      runtime,
      userMessage(userText),
      undefined,
      { parameters },
      undefined,
    );

    // success is false until the owner completes OAuth; handoff is still verified.
    expect(result?.success).toBe(false);
    expect(result?.verifiedUserFacing).toBe(true);
    expect(result?.userFacingText).toMatch(/not connected until/i);
    const connection = (
      result?.data as {
        connection?: {
          state?: string;
          authUrl?: string;
          provider?: string;
        };
      }
    )?.connection;
    expect(connection?.state).toBe("authorization_required");
    const hostPath = connection?.authUrl
      ? (() => {
          const u = new URL(connection.authUrl);
          return `${u.origin}${u.pathname}`;
        })()
      : null;
    expect(hostPath).toBe("https://accounts.google.com/o/oauth2/v2/auth");

    const trajectory = {
      id: "configured-authorization-handoff",
      evidenceHead: HEAD,
      capturedAt: new Date().toISOString(),
      provider: plan.provider,
      model: plan.model,
      input: { userText, messages: plan.messages },
      messages: plan.messages,
      prompt: plan.messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
      request: {
        messages: plan.messages,
        tools: ["CALENDAR_SOURCES", "CONNECTOR"],
      },
      output: {
        planner: {
          content: plan.content,
          tool_calls: plan.tool_calls,
          finish_reason: plan.finish_reason,
        },
        toolName: "CALENDAR_SOURCES",
        toolParameters: parameters,
        actionResult: {
          success: result?.success,
          verifiedUserFacing: result?.verifiedUserFacing,
          userFacingText: result?.userFacingText,
          connection: {
            state: connection?.state,
            provider: connection?.provider,
            authUrlHostPath: hostPath,
          },
        },
      },
      response: JSON.stringify({
        tool: "CALENDAR_SOURCES",
        parameters,
        state: connection?.state,
        authUrlHostPath: hostPath,
        userFacingText: result?.userFacingText,
      }),
      completion: result?.userFacingText ?? "",
      steps: [
        {
          kind: "planner",
          provider: plan.provider,
          model: plan.model,
          tool_calls: plan.tool_calls,
        },
        {
          kind: "action",
          name: "CALENDAR_SOURCES",
          parameters,
          connectionState: connection?.state,
          authUrlHostPath: hostPath,
        },
      ],
      usage: plan.usage,
    };
    writeFileSync(
      path.join(OUTDIR, "configured-authorization-handoff.json"),
      JSON.stringify(trajectory, null, 2),
    );
  }, 120_000);

  it("incomplete config: live plan → verified [CONFIG:google-workspace] card", async () => {
    mkdirSync(OUTDIR, { recursive: true });
    const userText = "please link my google calendar";
    const plan = await livePlan(userText);
    const tool = plan.tool_calls[0];
    expect(tool?.function?.name).toBe("CALENDAR_SOURCES");
    const parameters = JSON.parse(tool?.function?.arguments || "{}") as {
      operation?: string;
      provider?: string;
    };
    expect(parameters.operation).toBe("connect");
    expect(parameters.provider).toBe("google");

    const { runtime, manager } = runtimeFixture();
    manager.registerProvider({
      provider: "google",
      startOAuth: async () => {
        throw new Error(
          "Google OAuth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to be configured.",
        );
      },
    });

    const result = await calendarSourcesAction.handler(
      runtime,
      userMessage(userText),
      undefined,
      { parameters },
      undefined,
    );

    expect(result?.success).toBe(false);
    expect(result?.verifiedUserFacing).toBe(true);
    expect(result?.userFacingText).toContain("[CONFIG:google-workspace]");
    const connection = (
      result?.data as {
        connection?: {
          state?: string;
          connectorId?: string;
          provider?: string;
        };
      }
    )?.connection;
    expect(connection?.connectorId).toBe("google-workspace");
    expect(connection?.state).toBe("configuration_required");

    const trajectory = {
      id: "incomplete-config-recovery",
      evidenceHead: HEAD,
      capturedAt: new Date().toISOString(),
      provider: plan.provider,
      model: plan.model,
      input: { userText, messages: plan.messages },
      messages: plan.messages,
      prompt: plan.messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
      request: {
        messages: plan.messages,
        tools: ["CALENDAR_SOURCES", "CONNECTOR"],
      },
      output: {
        planner: {
          content: plan.content,
          tool_calls: plan.tool_calls,
          finish_reason: plan.finish_reason,
        },
        toolName: "CALENDAR_SOURCES",
        toolParameters: parameters,
        actionResult: {
          success: result?.success,
          verifiedUserFacing: result?.verifiedUserFacing,
          userFacingText: result?.userFacingText,
          connection: {
            state: connection?.state,
            provider: connection?.provider,
            connectorId: connection?.connectorId,
          },
        },
      },
      response: JSON.stringify({
        tool: "CALENDAR_SOURCES",
        parameters,
        state: connection?.state,
        connectorId: connection?.connectorId,
        userFacingText: result?.userFacingText,
      }),
      completion: result?.userFacingText ?? "",
      steps: [
        {
          kind: "planner",
          provider: plan.provider,
          model: plan.model,
          tool_calls: plan.tool_calls,
        },
        {
          kind: "action",
          name: "CALENDAR_SOURCES",
          parameters,
          connectionState: connection?.state,
          connectorId: connection?.connectorId,
          userFacingText: result?.userFacingText,
        },
      ],
      usage: plan.usage,
    };
    writeFileSync(
      path.join(OUTDIR, "incomplete-config-recovery.json"),
      JSON.stringify(trajectory, null, 2),
    );

    // Combined artifact for PR evidence row
    const authPath = path.join(OUTDIR, "configured-authorization-handoff.json");
    let auth: unknown = null;
    try {
      auth = JSON.parse(
        await (await import("node:fs/promises")).readFile(authPath, "utf8"),
      );
    } catch {
      auth = null;
    }
    const combined = {
      provider: "openai-compatible",
      model: MODEL,
      evidenceHead: HEAD,
      input: {
        cases: ["connect google calendar", "please link my google calendar"],
        description:
          "Live planner selects CALENDAR_SOURCES; real handler returns trusted auth URL or [CONFIG:google-workspace]",
      },
      messages: [...plan.messages],
      output: {
        configuredAuthorization: auth,
        incompleteConfig: trajectory,
      },
      response: trajectory.response,
      completion: `${(auth as { completion?: string } | null)?.completion ?? ""}\n---\n${trajectory.completion}`,
      steps: trajectory.steps,
    };
    // Prefer richer combined if both exist
    if (auth && typeof auth === "object") {
      const a = auth as {
        messages?: unknown[];
        response?: string;
        completion?: string;
        steps?: unknown[];
        output?: unknown;
      };
      combined.messages = [
        ...((a.messages as typeof plan.messages) ?? []),
        ...plan.messages,
      ];
      combined.response = `${a.response ?? ""}\n---\n${trajectory.response}`;
      combined.completion = `${a.completion ?? ""}\n---\n${trajectory.completion}`;
      combined.steps = [
        ...((a.steps as typeof trajectory.steps) ?? []),
        ...trajectory.steps,
      ];
      combined.output = {
        configuredAuthorization: a.output ?? auth,
        incompleteConfig: trajectory.output,
      };
    }
    writeFileSync(
      path.join(OUTDIR, "combined-llm-trajectory.json"),
      JSON.stringify(combined, null, 2),
    );
    writeFileSync(
      path.join(OUTDIR, "llm-calls.jsonl"),
      `${[auth, trajectory]
        .filter(Boolean)
        .map((t) => JSON.stringify(t))
        .join("\n")}\n`,
    );
  }, 120_000);
});
