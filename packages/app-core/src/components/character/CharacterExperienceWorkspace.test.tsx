// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterExperienceWorkspace } from "./CharacterExperienceWorkspace";
import type { CharacterExperienceRecord } from "./character-hub-types";

const experiences: CharacterExperienceRecord[] = [
  {
    id: "exp-1",
    type: "interaction",
    outcome: "negative",
    context: "A user asked for a direct wallet swap without enough details.",
    action: "Asked for source token, destination token, amount, and slippage.",
    result: "The user supplied the missing route details before execution.",
    learning:
      "Always collect complete swap parameters before preparing a wallet transaction.",
    tags: ["wallet", "safety"],
    domain: "finance",
    confidence: 0.55,
    importance: 0.92,
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-21T12:00:00.000Z",
    previousBelief: "The source token alone was enough to start a swap.",
    correctedBelief:
      "A swap requires source, destination, amount, slippage, and route confirmation.",
    relatedExperienceIds: ["exp-2"],
    sourceMessageIds: ["msg-1", "msg-2", "msg-3"],
    sourceRoomId: "room-wallet-review",
    sourceTriggerMessageId: "msg-3",
    sourceTrajectoryStepId: "trajectory-step-wallet",
    extractionMethod: "experience_evaluator",
    extractionReason:
      "The interaction corrected an unsafe assumption about wallet swap readiness.",
  },
  {
    id: "exp-2",
    type: "conversation",
    outcome: "positive",
    context: "A user asked for a concise release note summary.",
    action:
      "Grouped changes by user impact and omitted internal implementation noise.",
    result: "The user accepted the summary without follow-up edits.",
    learning:
      "For release notes, group by user impact before implementation detail.",
    tags: ["writing", "release-notes"],
    domain: "communications",
    confidence: 0.86,
    importance: 0.48,
    createdAt: "2026-04-22T12:00:00.000Z",
  },
  {
    id: "exp-3",
    type: "correction",
    outcome: "mixed",
    context:
      "A stale preference contradicted newer feedback about automation cadence.",
    action: "Kept the newer preference and linked the earlier experience.",
    result: "Future automation suggestions used the corrected cadence.",
    learning:
      "Prefer the latest explicit cadence preference when automation guidance conflicts.",
    tags: ["automation", "preference"],
    domain: "planning",
    confidence: 0.72,
    importance: 0.82,
    createdAt: "2026-04-23T12:00:00.000Z",
    supersedes: "exp-2",
  },
];

function renderWorkspace(
  props: Partial<ComponentProps<typeof CharacterExperienceWorkspace>> = {},
) {
  const onSelectExperience = props.onSelectExperience ?? vi.fn();
  return render(
    <CharacterExperienceWorkspace
      experiences={experiences}
      selectedExperienceId="exp-1"
      onSelectExperience={onSelectExperience}
      {...props}
    />,
  );
}

describe("CharacterExperienceWorkspace", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders an operational empty state", () => {
    render(
      <CharacterExperienceWorkspace
        experiences={[]}
        selectedExperienceId={null}
        onSelectExperience={() => {}}
      />,
    );

    expect(
      screen.getByText(/I\s+haven.+t\s+learned\s+anything\s+yet\./),
    ).toBeTruthy();
    expect(
      screen.getByText(/Each lesson lands with the context that produced it/i),
    ).toBeTruthy();
  });

  it("filters the review queue and selects matching experiences", () => {
    const onSelectExperience = vi.fn();
    renderWorkspace({ onSelectExperience });

    fireEvent.change(screen.getByPlaceholderText(/search learning/i), {
      target: { value: "release notes" },
    });

    expect(screen.getByTestId("experience-row-exp-2")).toBeTruthy();
    expect(screen.queryByTestId("experience-row-exp-1")).toBeNull();
    expect(
      within(screen.getByTestId("experience-row-exp-2")).getByText(
        /group by user impact/i,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("experience-row-exp-2"));

    expect(onSelectExperience).toHaveBeenCalledWith("exp-2");
  });

  it("supports review filters for corrected and superseding experiences", () => {
    renderWorkspace();

    fireEvent.change(screen.getByLabelText("Review filter"), {
      target: { value: "superseded" },
    });

    expect(screen.getByTestId("experience-row-exp-3")).toBeTruthy();
    expect(screen.queryByTestId("experience-row-exp-1")).toBeNull();
    expect(screen.getAllByText(/Supersedes/).length).toBeGreaterThan(0);
    expect(screen.getByText(/exp-2/)).toBeTruthy();
  });

  it("shows provenance for review and evidence replay", () => {
    renderWorkspace();

    expect(screen.getByText("Evidence source")).toBeTruthy();
    expect(screen.getByText("experience_evaluator")).toBeTruthy();
    expect(screen.getByText("room-wallet-...")).toBeTruthy();
    expect(screen.getByText("3 captured")).toBeTruthy();
    expect(screen.getByText("trajectory-s...")).toBeTruthy();
    expect(screen.getByText(/corrected an unsafe assumption/i)).toBeTruthy();
  });

  it("saves edited learning, ranking, and tags for the selected experience", () => {
    const onSaveExperience = vi.fn();
    renderWorkspace({ onSaveExperience });

    fireEvent.change(screen.getByLabelText("Learning"), {
      target: {
        value:
          "Require complete wallet swap instructions before drafting any transaction.",
      },
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

    expect(onSaveExperience).toHaveBeenCalledWith(
      experiences[0],
      expect.objectContaining({
        confidence: 0.7,
        importance: 0.88,
        learning:
          "Require complete wallet swap instructions before drafting any transaction.",
        tags: "wallet, safety, review",
      }),
    );
  });

  it("calls delete for the active experience and reflects delete busy state", () => {
    const onDeleteExperience = vi.fn();
    renderWorkspace({
      deletingExperienceId: "exp-1",
      onDeleteExperience,
    });

    const deletingButton = screen.getByRole("button", { name: "Deleting..." });
    expect((deletingButton as HTMLButtonElement).disabled).toBe(true);

    cleanup();

    renderWorkspace({ onDeleteExperience });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDeleteExperience).toHaveBeenCalledWith(experiences[0]);
  });
});
