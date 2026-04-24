// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterData, ExperienceRecord } from "../../api/client-types";

const { clientMock, useAppMock } = vi.hoisted(() => ({
  clientMock: {
    deleteExperience: vi.fn(),
    getRelationshipsActivity: vi.fn(),
    listCharacterHistory: vi.fn(),
    listExperiences: vi.fn(),
    listKnowledgeDocuments: vi.fn(),
    updateCharacter: vi.fn(),
    updateExperience: vi.fn(),
  },
  useAppMock: vi.fn(),
}));

vi.mock("@elizaos/ui", () => {
  const passThrough =
    (Tag: "div" | "section" | "span" = "div") =>
    ({
      active: _active,
      children,
      ...props
    }: HTMLAttributes<HTMLElement> & { active?: boolean }) => {
      const Component = Tag;
      return <Component {...props}>{children}</Component>;
    };

  const SidebarContent = {
    Item: ({
      active: _active,
      children,
      onClick,
      ...props
    }: HTMLAttributes<HTMLButtonElement> & { active?: boolean }) => (
      <button type="button" onClick={onClick} {...props}>
        {children}
      </button>
    ),
    ItemBody: passThrough("span"),
    ItemIcon: passThrough("span"),
    ItemTitle: passThrough("span"),
    SectionLabel: passThrough("div"),
  };

  return {
    Button: ({
      children,
      size: _size,
      variant: _variant,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & {
      size?: string;
      variant?: string;
    }) => <button {...props}>{children}</button>,
    Input: (props: InputHTMLAttributes<HTMLInputElement>) => (
      <input {...props} />
    ),
    PageLayout: ({
      children,
      sidebar,
      ...props
    }: {
      children?: ReactNode;
      sidebar?: ReactNode;
      "data-testid"?: string;
    }) => (
      <main data-testid={props["data-testid"]}>
        <aside>{sidebar}</aside>
        {children}
      </main>
    ),
    SidebarContent,
    SidebarPanel: passThrough("section"),
    SidebarScrollRegion: passThrough("div"),
    Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
      <textarea {...props} />
    ),
  };
});

vi.mock("../../api/client", () => ({
  client: clientMock,
}));

vi.mock("../../state/useApp", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../pages/KnowledgeView", () => ({
  KnowledgeView: () => <div>Knowledge view</div>,
}));

vi.mock("../pages/relationships/RelationshipsWorkspaceView", () => ({
  RelationshipsWorkspaceView: () => <div>Relationships workspace</div>,
}));

vi.mock("../shared/AppPageSidebar", () => ({
  AppPageSidebar: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("./CharacterEditorPanels", () => ({
  CharacterExamplesPanel: () => <div>Examples panel</div>,
  CharacterIdentityPanel: () => <div>Identity panel</div>,
  CharacterStylePanel: () => <div>Style panel</div>,
}));

vi.mock("./CharacterOverviewSection", () => ({
  CharacterOverviewSection: () => <div>Overview section</div>,
}));

vi.mock("./CharacterPersonalityTimeline", () => ({
  CharacterPersonalityTimeline: () => <div>Personality timeline</div>,
}));

vi.mock("./CharacterRelationshipsSection", () => ({
  CharacterRelationshipsSection: ({ children }: { children?: ReactNode }) => (
    <section>{children}</section>
  ),
}));

import { CharacterHubView } from "./CharacterHubView";

const experience: ExperienceRecord = {
  accessCount: 0,
  action: "Asked for source token, destination token, amount, and slippage.",
  confidence: 0.55,
  context: "A user asked for a direct wallet swap without enough details.",
  createdAt: "2026-04-20T12:00:00.000Z",
  domain: "finance",
  id: "exp-1",
  importance: 0.92,
  learning:
    "Always collect complete swap parameters before preparing a wallet transaction.",
  outcome: "negative",
  result: "The user supplied the missing route details before execution.",
  tags: ["wallet", "safety"],
  type: "interaction",
  updatedAt: "2026-04-21T12:00:00.000Z",
};

const character = {
  bio: [],
  messageExamples: [],
  name: "Milady",
  postExamples: [],
  style: {
    all: [],
    chat: [],
    post: [],
  },
} as CharacterData;

function renderHub() {
  return render(
    <CharacterHubView
      d={character}
      bioText=""
      normalizedMessageExamples={[]}
      pendingStyleEntries={{}}
      styleEntryDrafts={{}}
      handleFieldEdit={() => {}}
      applyFieldEdit={() => {}}
      handlePendingStyleEntryChange={() => {}}
      applyStyleEdit={() => {}}
      handleStyleEntryDraftChange={() => {}}
      characterSaving={false}
      characterSaveSuccess={null}
      characterSaveError={null}
      hasPendingChanges={false}
      onSave={async () => ({})}
      onReset={() => {}}
      canReset={false}
    />,
  );
}

describe("CharacterHubView experience tab", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/character/experience");
    useAppMock.mockReturnValue({
      setActionNotice: vi.fn(),
      setTab: vi.fn(),
      t: (key: string, options?: Record<string, unknown>) =>
        String(options?.defaultValue ?? key),
      tab: "character",
    });
    clientMock.listCharacterHistory.mockResolvedValue({ history: [] });
    clientMock.getRelationshipsActivity.mockResolvedValue({ activity: [] });
    clientMock.listKnowledgeDocuments.mockResolvedValue({
      documents: [],
      total: 0,
    });
    clientMock.listExperiences.mockResolvedValue({
      experiences: [experience],
      total: 1,
    });
    clientMock.updateCharacter.mockResolvedValue({
      agentName: "Milady",
      character,
      ok: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.history.pushState(null, "", "/");
  });

  it("loads experiences when the character page opens directly to the Experience tab", async () => {
    renderHub();

    expect(screen.getByText("Loading experiences…")).toBeTruthy();

    expect(
      (await screen.findAllByText(experience.learning)).length,
    ).toBeGreaterThan(0);
    expect(clientMock.listExperiences).toHaveBeenCalledWith({ limit: 100 });
    expect(screen.getByText("1 of 1 shown")).toBeTruthy();
  });

  it("saves review edits through the character experience API and deletes the reviewed item", async () => {
    const updatedLearning =
      "Require complete wallet swap instructions before drafting any transaction.";
    clientMock.updateExperience.mockResolvedValue({
      experience: {
        ...experience,
        confidence: 0.7,
        importance: 0.88,
        learning: updatedLearning,
        tags: ["wallet", "safety", "review"],
      },
    });
    clientMock.deleteExperience.mockResolvedValue({ ok: true });

    renderHub();
    await screen.findAllByText(experience.learning);

    fireEvent.change(screen.getByLabelText("Learning"), {
      target: { value: updatedLearning },
    });
    fireEvent.change(screen.getByLabelText("Importance"), {
      target: { value: "0.88" },
    });
    fireEvent.change(screen.getByLabelText("Confidence"), {
      target: { value: "0.7" },
    });
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "wallet, safety, review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

    await waitFor(() => {
      expect(clientMock.updateExperience).toHaveBeenCalledWith("exp-1", {
        confidence: 0.7,
        importance: 0.88,
        learning: updatedLearning,
        tags: ["wallet", "safety", "review"],
      });
    });
    expect(
      (await screen.findAllByText(updatedLearning)).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(clientMock.deleteExperience).toHaveBeenCalledWith("exp-1");
    });
    expect(await screen.findByText("No experiences recorded yet.")).toBeTruthy();
  });
});
