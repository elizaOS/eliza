// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

vi.mock("./LifeOpsAssistantSection.js", () => ({
  LifeOpsAssistantSection: () => (
    <section data-testid="lifeops-assistant-section" />
  ),
}));

vi.mock("./LifeOpsCalendarSection.js", () => ({
  LifeOpsCalendarSection: () => <section data-testid="calendar-section" />,
}));

vi.mock("./LifeOpsDocumentsSection.js", () => ({
  LifeOpsDocumentsSection: () => <section data-testid="documents-section" />,
}));

vi.mock("./LifeOpsInboxSection.js", () => ({
  LifeOpsInboxSection: () => <section data-testid="inbox-section" />,
}));

vi.mock("./LifeOpsInboxSection.helpers.js", () => ({
  LIFEOPS_MAIL_CHANNELS: ["gmail"],
  LIFEOPS_MESSAGE_CHANNELS: ["discord"],
}));

vi.mock("./LifeOpsMoneySection.js", () => ({
  LifeOpsMoneySection: () => <section data-testid="money-section" />,
}));

vi.mock("./LifeOpsOverviewSection.js", () => ({
  LifeOpsOverviewSection: () => <section data-testid="overview-section" />,
}));

vi.mock("./LifeOpsRemindersSection.js", () => ({
  LifeOpsRemindersSection: () => <section data-testid="reminders-section" />,
}));

import { LifeOpsSectionContent } from "./LifeOpsSectionContent.js";

afterEach(cleanup);

function renderSection(section: LifeOpsSection): void {
  render(
    <LifeOpsSectionContent
      section={section}
      navigate={() => undefined}
      setupContent={<section data-testid="setup-section" />}
    />,
  );
}

describe("LifeOpsSectionContent", () => {
  it("routes legacy health deep links into the assistant surface", () => {
    renderSection("sleep");
    expect(screen.getByTestId("lifeops-assistant-section")).toBeTruthy();
    cleanup();

    renderSection("screen-time");
    expect(screen.getByTestId("lifeops-assistant-section")).toBeTruthy();
  });

  it("keeps personal assistant sections owned by LifeOps", () => {
    const sections: Array<[LifeOpsSection, string]> = [
      ["assistant", "lifeops-assistant-section"],
      ["overview", "overview-section"],
      ["calendar", "calendar-section"],
      ["messages", "inbox-section"],
      ["mail", "inbox-section"],
      ["reminders", "reminders-section"],
      ["money", "money-section"],
      ["documents", "documents-section"],
      ["setup", "setup-section"],
    ];

    for (const [section, testId] of sections) {
      renderSection(section);
      expect(screen.getByTestId(testId)).toBeTruthy();
      cleanup();
    }
  });
});
