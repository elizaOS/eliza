// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIFEOPS_ROUTE_SECTIONS,
  type LifeOpsRouteSection,
} from "../lifeops-route.js";

vi.mock("./LifeOpsOverviewSection.js", () => ({
  LifeOpsOverviewSection: () => <div data-testid="section-overview" />,
}));

vi.mock("./LifeOpsSleepSection.js", () => ({
  LifeOpsSleepSection: () => <div data-testid="section-sleep" />,
}));

vi.mock("./LifeOpsScreenTimeSection.js", () => ({
  LifeOpsScreenTimeSection: () => <div data-testid="section-screen-time" />,
}));

vi.mock("./LifeOpsCalendarSection.js", () => ({
  LifeOpsCalendarSection: () => <div data-testid="section-calendar" />,
}));

vi.mock("./LifeOpsInboxSection.js", () => ({
  LIFEOPS_MAIL_CHANNELS: ["gmail"],
  LIFEOPS_MESSAGE_CHANNELS: ["imessage", "signal"],
  LifeOpsInboxSection: ({ title }: { title: string }) => (
    <div data-testid={`section-${title.toLowerCase()}`} />
  ),
}));

vi.mock("./LifeOpsRemindersSection.js", () => ({
  LifeOpsRemindersSection: () => <div data-testid="section-reminders" />,
}));

vi.mock("./LifeOpsMoneySection.js", () => ({
  LifeOpsMoneySection: () => <div data-testid="section-money" />,
}));

import { LifeOpsSectionContent } from "./LifeOpsSectionContent.js";

const SECTION_TEST_IDS = {
  overview: "section-overview",
  sleep: "section-sleep",
  "screen-time": "section-screen-time",
  setup: "section-setup",
  reminders: "section-reminders",
  calendar: "section-calendar",
  messages: "section-messages",
  mail: "section-mail",
  money: "section-money",
} satisfies Record<LifeOpsRouteSection, string>;

function renderSection(section: LifeOpsRouteSection): void {
  render(
    <LifeOpsSectionContent
      section={section}
      navigate={vi.fn()}
      setupContent={<div data-testid="section-setup" />}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("LifeOpsSectionContent", () => {
  it.each(LIFEOPS_ROUTE_SECTIONS)(
    "renders the %s section",
    (section) => {
      renderSection(section);

      expect(screen.getByTestId(SECTION_TEST_IDS[section])).toBeTruthy();
    },
  );
});
