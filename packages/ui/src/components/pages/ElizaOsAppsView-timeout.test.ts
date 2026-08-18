/**
 * Behavioral Android SMS gateway deadline. Executes
 * postAndroidSmsGatewayWithFetch under abort — not a source-grep.
 * Not Twilio. Not #21385.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../bridge/plugin-bridge", () => ({
  getPlugins: () => ({
    messages: {
      plugin: {
        listMessages: async () => ({ messages: [] }),
      },
    },
  }),
}));

vi.mock("../../bridge/native-plugins", () => ({}));

vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: unknown }) => children,
}));

vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("../ui/input", () => ({ Input: () => null }));
vi.mock("../ui/textarea", () => ({ Textarea: () => null }));

vi.mock("lucide-react", () => ({
  Clock3: () => null,
  ContactRound: () => null,
  FileUp: () => null,
  MessageSquare: () => null,
  NotebookText: () => null,
  PhoneCall: () => null,
  Plus: () => null,
  RefreshCw: () => null,
  Search: () => null,
  Send: () => null,
  Settings: () => null,
  ShieldCheck: () => null,
  UserPlus: () => null,
}));

import {
  ANDROID_SMS_GATEWAY_FETCH_TIMEOUT_MS,
  postAndroidSmsGatewayWithFetch,
} from "./ElizaOsAppsView";

const URL = "http://test.local/api/webhooks/android-sms";
const BODY = JSON.stringify({ type: "new-message", data: { text: "hi" } });
const SECRET = "test-secret";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected android-sms-gateway abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("ElizaOsAppsView Android SMS gateway deadline", () => {
  it("keeps a documented UI fetch budget", () => {
    expect(ANDROID_SMS_GATEWAY_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled gateway POST at the injected deadline", async () => {
    await expect(
      postAndroidSmsGatewayWithFetch(
        URL,
        BODY,
        SECRET,
        stallUntilAborted(),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("returns a completed provider error for the caller to decode", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    const response = await postAndroidSmsGatewayWithFetch(
      URL,
      BODY,
      SECRET,
      fetchImpl,
      1_000,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("nope");
  });

  it("uses the injected fetch for a successful gateway POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(JSON.stringify({ replyText: "pong" }), {
        status: 200,
      });
    };

    const response = await postAndroidSmsGatewayWithFetch(
      URL,
      BODY,
      SECRET,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ replyText: "pong" });
  });
});
