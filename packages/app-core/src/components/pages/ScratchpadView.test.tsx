// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScratchpadTopicDto } from "../../api/client-types-chat";

const { clientMock, useAppMock } = vi.hoisted(() => ({
  clientMock: {
    createScratchpadTopic: vi.fn(),
    deleteScratchpadTopic: vi.fn(),
    getScratchpadTopic: vi.fn(),
    listScratchpadTopics: vi.fn(),
    previewScratchpadSummary: vi.fn(),
    replaceScratchpadTopic: vi.fn(),
    searchScratchpadTopics: vi.fn(),
  },
  useAppMock: vi.fn(),
}));

vi.mock("@elizaos/ui", () => {
  const PagePanel = Object.assign(
    ({ children, className }: { children?: ReactNode; className?: string }) => (
      <section className={className}>{children}</section>
    ),
    {
      Empty: ({
        children,
        description,
        title,
      }: {
        children?: ReactNode;
        description?: ReactNode;
        title?: ReactNode;
      }) => (
        <div>
          <div>{title}</div>
          <div>{description}</div>
          {children}
        </div>
      ),
      Notice: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  );

  return {
    Button: ({
      children,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    PagePanel,
  };
});

vi.mock("../../api/client", () => ({
  client: clientMock,
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../state/useApp", () => ({
  useApp: () => useAppMock(),
}));

import { ScratchpadView } from "./ScratchpadView";

function buildUseAppState() {
  return {
    setActionNotice: vi.fn(),
    t: (key: string, options?: Record<string, unknown>) => {
      let value = String(options?.defaultValue ?? key);
      for (const [optionKey, optionValue] of Object.entries(options ?? {})) {
        value = value.replaceAll(`{{${optionKey}}}`, String(optionValue));
      }
      return value;
    },
  };
}

function buildTopic(
  overrides: Partial<ScratchpadTopicDto> = {},
): ScratchpadTopicDto {
  return {
    createdAt: 1_713_916_800_000,
    fragmentCount: 2,
    id: "topic-1",
    summary: "Launch summary",
    text: "Full launch notes",
    title: "Launch plan",
    tokenCount: 42,
    updatedAt: 1_713_916_900_000,
    ...overrides,
  };
}

function listResponse(topics: ScratchpadTopicDto[]) {
  return {
    count: topics.length,
    maxTokensPerTopic: 8000,
    maxTopics: 10,
    topics,
  };
}

describe("ScratchpadView", () => {
  beforeEach(() => {
    useAppMock.mockReturnValue(buildUseAppState());
    clientMock.previewScratchpadSummary.mockResolvedValue({
      summary: "Draft summary",
      tokenCount: 7,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists topics, reads the selected topic, and displays server token counts", async () => {
    const topic = buildTopic();
    clientMock.listScratchpadTopics.mockResolvedValue(listResponse([topic]));
    clientMock.getScratchpadTopic.mockResolvedValue({ topic });

    render(<ScratchpadView />);

    expect(await screen.findAllByText("Launch plan")).toHaveLength(2);
    expect(clientMock.getScratchpadTopic).toHaveBeenCalledWith("topic-1");
    expect(screen.getByText("1 / 10 topics")).toBeTruthy();
    expect(screen.getByText("42 / 8000 tokens")).toBeTruthy();
    expect((screen.getByLabelText("Text") as HTMLTextAreaElement).value).toBe(
      "Full launch notes",
    );
  });

  it("creates a new topic through the scratchpad client", async () => {
    const created = buildTopic({
      id: "topic-created",
      text: "Fresh notes",
      title: "Fresh topic",
    });
    clientMock.listScratchpadTopics
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(listResponse([created]));
    clientMock.createScratchpadTopic.mockResolvedValue({ topic: created });
    clientMock.getScratchpadTopic.mockResolvedValue({ topic: created });
    const appState = buildUseAppState();
    useAppMock.mockReturnValue(appState);

    render(<ScratchpadView />);

    await screen.findByText("No scratchpad topics");
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Fresh topic" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "Fresh notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => {
      expect(clientMock.createScratchpadTopic).toHaveBeenCalledWith({
        text: "Fresh notes",
        title: "Fresh topic",
      });
    });
    expect(appState.setActionNotice).toHaveBeenCalledWith(
      "Scratchpad topic created.",
      "success",
    );
  });

  it("searches topics through the server search endpoint", async () => {
    const topic = buildTopic();
    const resultTopic = buildTopic({
      id: "topic-2",
      summary: "Search hit summary",
      title: "Search hit",
    });
    clientMock.listScratchpadTopics.mockResolvedValue(listResponse([topic]));
    clientMock.getScratchpadTopic.mockResolvedValue({ topic });
    clientMock.searchScratchpadTopics.mockResolvedValue({
      count: 1,
      limit: 10,
      query: "launch",
      results: [
        {
          matches: [
            {
              fragmentId: "fragment-1",
              score: 0.8,
              text: "launch match",
            },
          ],
          score: 0.8,
          topic: resultTopic,
        },
      ],
    });

    render(<ScratchpadView />);

    await screen.findAllByText("Launch plan");
    fireEvent.change(screen.getByPlaceholderText("Search scratchpad"), {
      target: { value: "launch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Search hit")).toBeTruthy();
    expect(clientMock.searchScratchpadTopics).toHaveBeenCalledWith("launch", {
      limit: 10,
    });
  });

  it("replaces and deletes the selected topic", async () => {
    const topic = buildTopic();
    const updated = buildTopic({
      text: "Updated notes",
      title: "Updated plan",
      tokenCount: 55,
    });
    clientMock.listScratchpadTopics
      .mockResolvedValueOnce(listResponse([topic]))
      .mockResolvedValueOnce(listResponse([updated]))
      .mockResolvedValueOnce(listResponse([]));
    clientMock.getScratchpadTopic
      .mockResolvedValueOnce({ topic })
      .mockResolvedValueOnce({ topic: updated });
    clientMock.replaceScratchpadTopic.mockResolvedValue({ topic: updated });
    clientMock.deleteScratchpadTopic.mockResolvedValue({
      deletedFragments: 2,
      ok: true,
      topicId: "topic-1",
    });

    render(<ScratchpadView />);

    await screen.findByDisplayValue("Full launch notes");
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Updated plan" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "Updated notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => {
      expect(clientMock.replaceScratchpadTopic).toHaveBeenCalledWith(
        "topic-1",
        {
          text: "Updated notes",
          title: "Updated plan",
        },
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(clientMock.deleteScratchpadTopic).toHaveBeenCalledWith("topic-1");
    });
  });
});
