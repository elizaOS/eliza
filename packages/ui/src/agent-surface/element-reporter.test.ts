/**
 * Unit coverage for agent-surface element-reporter payload building against the
 * view registry. Pure functions, no live agent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api/client";
import {
  buildPayload,
  reportAgentSurfaceElementSnapshot,
} from "./element-reporter.hooks";
import { ViewAgentRegistry } from "./registry";

const fetchWithCsrfMock = vi.hoisted(() => vi.fn());

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: fetchWithCsrfMock,
}));

describe("element-reporter buildPayload", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
    fetchWithCsrfMock.mockResolvedValue(new Response("{}"));
  });

  it("maps the registry snapshot to the report payload shape", () => {
    const registry = new ViewAgentRegistry("wallet", "gui");
    registry.register(
      {
        id: "amount",
        label: "Amount",
        role: "text-input",
        getValue: () => "5",
      },
      () => null,
    );
    registry.register(
      { id: "send", label: "Send", role: "button" },
      () => null,
    );

    const payload = buildPayload(registry);
    expect(payload.viewId).toBe("wallet");
    expect(payload.viewType).toBe("gui");
    const byId = Object.fromEntries(payload.elements.map((e) => [e.id, e]));
    expect(byId.amount).toMatchObject({
      id: "amount",
      role: "text-input",
      label: "Amount",
      value: "5",
    });
    expect(byId.send).toMatchObject({
      id: "send",
      role: "button",
      label: "Send",
    });
    // No spurious value/focused keys when absent.
    expect("value" in byId.send).toBe(false);
    expect("focused" in byId.send).toBe(false);
  });

  it("does not report values for sensitive elements", () => {
    const registry = new ViewAgentRegistry("auth", "gui");
    registry.register(
      {
        id: "password",
        label: "Password",
        role: "text-input",
        sensitive: true,
        getValue: () => "secret-value",
      },
      () => null,
    );

    const payload = buildPayload(registry);
    expect(payload.elements[0]).toMatchObject({
      id: "password",
      role: "text-input",
      label: "Password",
    });
    expect("value" in payload.elements[0]).toBe(false);
  });

  it("returns an empty element list for an empty view", () => {
    const registry = new ViewAgentRegistry("empty", "gui");
    expect(buildPayload(registry).elements).toEqual([]);
  });

  it("reports the real snapshot body with the shell WebSocket client identity", async () => {
    const postedSnapshots: Array<[string, RequestInit]> = [];
    fetchWithCsrfMock.mockImplementation(
      async (url: string, init: RequestInit) => {
        postedSnapshots.push([url, init]);
        return new Response("{}");
      },
    );
    const registry = new ViewAgentRegistry("calendar", "gui");
    registry.register(
      { id: "create-event", label: "Create event", role: "button" },
      () => null,
    );

    await reportAgentSurfaceElementSnapshot(registry);

    expect(postedSnapshots).toHaveLength(1);
    const [url, init] = postedSnapshots[0];
    expect(url).toContain("/api/views/calendar/elements");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-ElizaOS-Client-Id": client.getClientId(),
    });
    expect(JSON.parse(String(init.body))).toEqual({
      viewType: "gui",
      elements: [{ id: "create-event", role: "button", label: "Create event" }],
    });
  });
});
