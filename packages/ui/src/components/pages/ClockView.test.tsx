// @vitest-environment jsdom
/** Exercises renderer failure feedback through the registered Clock host. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ClockHost,
  configureClockHost,
  getClockHost,
  retireClockHost,
} from "../../bridge/clock-host";
import { ClockView } from "./ClockView";

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../layouts/framed-page", () => ({
  FramedPage: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FramedPageBody: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../../agent-surface/useAgentElement", () => ({
  useAgentElement: () => ({ ref: undefined, agentProps: {} }),
}));
const sharedNow = vi.hoisted(() => ({
  read: (): number => Date.now(),
}));
vi.mock("../../hooks/useSharedNow", () => ({
  useSharedNow: () => sharedNow.read(),
}));

beforeEach(() => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});

afterEach(async () => {
  sharedNow.read = () => Date.now();
  cleanup();
  const host = getClockHost();
  if (host) await retireClockHost(host);
  vi.restoreAllMocks();
});
function hostFixture(): ClockHost {
  return {
    status: async () => ({
      supported: true,
      agentBase: "https://agent.example",
      reason: null,
      capabilities: [],
      scope: "owner",
      installationId: "phone",
      context: null,
    }),
    proposals: async () => ({ scope: "owner", proposals: [] }),
    review: async () => {
      throw Error("No review expected");
    },
    subscribe: () => () => {},
    retire: async () => {},
  };
}
it.each(["status", "proposals"] as const)(
  "shows an initial %s read failure and retries without an existing proposal",
  async (method) => {
    const host = hostFixture();
    const original = host[method];
    host[method] = vi
      .fn()
      .mockRejectedValueOnce(Error("Clock read unavailable"))
      .mockImplementation(original);
    configureClockHost(host);
    render(<ClockView />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Clock read unavailable",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh Clock requests" }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(host[method]).toHaveBeenCalledTimes(2);
  },
);
it.each(["denied", "failed", "unknown"] as const)(
  "keeps a returned %s alarm result visible inside its open editor",
  async (status) => {
    const host = hostFixture();
    host.alarmStatus = async () => ({
      available: true,
      reason: null,
      owner: "owner",
      alarmsRevision: 3,
      alarmsObservedAt: Date.now(),
      timeZone: "UTC",
      alarms: [],
      exactAlarmsAllowed: true,
      notificationsAllowed: true,
      fullScreenAllowed: true,
      alarmSoundMuted: false,
      defaultToneAvailable: true,
    });
    host.manageAlarm = vi.fn().mockResolvedValue({
      result: { kind: "clock-alarm", status },
      alarmsRevision: 3,
    });
    configureClockHost(host);
    render(<ClockView />);
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Add alarm" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add alarm" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save$/ }));
    const feedback = await within(dialog).findByRole("status");
    expect(feedback.classList.contains("sr-only")).toBe(false);
    expect(feedback.textContent).toContain(
      status === "denied"
        ? "cancelled"
        : status === "unknown"
          ? "could not be confirmed"
          : "failed",
    );
    expect(host.manageAlarm).toHaveBeenCalledOnce();
  },
);

function proposalHost(expiresAt: string): ClockHost {
  const host = hostFixture();
  host.status = async () => ({
    supported: true,
    agentBase: "https://agent.example",
    reason: null,
    capabilities: ["clock.handoff.v1"],
    scope: "owner",
    installationId: "phone",
    context: null,
  });
  host.proposals = async () => ({
    scope: "owner",
    proposals: [
      {
        id: "request-1",
        digest: "digest",
        state: "pending",
        expiresAt,
        operation: {
          type: "clock_handoff",
          action: "set",
          hour: 9,
          minute: 0,
          label: "Morning",
          timeZone: "UTC",
        },
      },
    ],
  });
  return host;
}

it("keeps a future request unreviewable until the shared clock leaves epoch", async () => {
  sharedNow.read = () => 0;
  configureClockHost(proposalHost("2026-12-01T00:00:00.000Z"));
  render(<ClockView />);
  const review = await screen.findByRole("button", {
    name: "Review on this phone",
  });
  expect(review.hasAttribute("disabled")).toBe(true);
  expect(
    screen.queryByText("Request expired. Send a new request in chat."),
  ).toBeNull();
});

it("expires a past request once the shared clock is known", async () => {
  sharedNow.read = () => Date.parse("2026-10-07T12:00:00.000Z");
  configureClockHost(proposalHost("2020-01-01T00:00:00.000Z"));
  render(<ClockView />);
  expect(
    await screen.findByText("Request expired. Send a new request in chat."),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Review on this phone" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

it("offers review for a future request once the shared clock is known", async () => {
  sharedNow.read = () => Date.parse("2026-10-07T12:00:00.000Z");
  configureClockHost(proposalHost("2026-12-01T00:00:00.000Z"));
  render(<ClockView />);
  const review = await screen.findByRole("button", {
    name: "Review on this phone",
  });
  expect(review.hasAttribute("disabled")).toBe(false);
});
