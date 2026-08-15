/**
 * Verifies the voice-profile settings lifecycle through a jsdom render backed
 * by the real client contract and deterministic in-memory mutations.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type VoiceProfile,
  VoiceProfilesClient,
} from "../../api/client-voice-profiles";
import { VoiceProfileSection } from "./VoiceProfileSection";

// Radix Select drives selection through pointer capture and scrolls the
// active item into view; jsdom implements neither, so stub them once.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
});

function fakeProfile(over: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    id: "p1",
    entityId: "e1",
    displayName: "Profile 1",
    relationshipLabel: null,
    isOwner: false,
    embeddingCount: 3,
    firstHeardAtMs: 1,
    lastHeardAtMs: 10,
    cohort: "guest",
    source: "auto-clustered",
    retentionDays: null,
    samplePreviewUri: null,
    samples: [],
    ...over,
  };
}

function makeClient(overrides?: Partial<VoiceProfilesClient>) {
  const base = new VoiceProfilesClient({
    fetch: async <T,>(): Promise<T> => ({ profiles: [] }) as T,
  });
  // shallow-replace only requested methods.
  return Object.assign(base, overrides);
}

describe("VoiceProfileSection", () => {
  it("renders OWNER pinned at top + Crown badge", () => {
    const client = makeClient();
    const profiles: VoiceProfile[] = [
      fakeProfile({
        id: "guest-1",
        displayName: "Unknown A",
        lastHeardAtMs: 5,
      }),
      fakeProfile({
        id: "owner-1",
        displayName: "Shaw",
        isOwner: true,
        cohort: "owner",
        lastHeardAtMs: 1,
      }),
    ];
    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={profiles}
      />,
    );

    const list = screen.getByTestId("voice-profile-list");
    const rows = list.querySelectorAll("li");
    // First row must be the owner.
    expect(rows[0]?.getAttribute("data-testid")).toBe(
      "voice-profile-row-owner-1",
    );
    expect(screen.getByTestId("voice-profile-crown-owner-1")).toBeTruthy();
  });

  it("renders an empty state when there are no profiles", () => {
    const client = makeClient();
    render(
      <VoiceProfileSection profilesClient={client} initialProfiles={[]} />,
    );
    expect(screen.getByTestId("voice-profile-empty")).toBeTruthy();
  });

  it("renames a profile via the inline editor + adapter.patch", async () => {
    const patch = vi.fn(async () => {});
    const client = makeClient({ patch });

    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[fakeProfile({ id: "g1", displayName: "Old name" })]}
      />,
    );

    const nameButton = screen.getByTestId("voice-profile-name-g1");
    fireEvent.click(nameButton);
    const input = screen.getByTestId(
      "voice-profile-rename-input-g1",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("g1", { displayName: "New name" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("voice-profile-name-g1").textContent).toBe(
        "New name",
      );
    });
  });

  it("deletes a non-owner profile via adapter.delete", async () => {
    const del = vi.fn(async () => {});
    const client = makeClient({ delete: del });

    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[fakeProfile({ id: "g1" })]}
      />,
    );

    const deleteBtn = screen.getByTestId("voice-profile-delete-g1");
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(del).toHaveBeenCalledWith("g1");
    });
    // The row is gone.
    expect(screen.queryByTestId("voice-profile-row-g1")).toBeNull();
  });

  it("refuses to delete the OWNER row", async () => {
    const del = vi.fn(async () => {});
    const client = makeClient({ delete: del });

    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[
          fakeProfile({ id: "owner-1", isOwner: true, cohort: "owner" }),
        ]}
      />,
    );

    // OWNER row has no delete button rendered.
    expect(screen.queryByTestId("voice-profile-delete-owner-1")).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it("changes the relationship label via the select", async () => {
    const user = userEvent.setup();
    const patch = vi.fn(async () => {});
    const client = makeClient({ patch });
    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[fakeProfile({ id: "g1" })]}
      />,
    );

    const trigger = screen.getByTestId("voice-profile-relationship-select-g1");
    // Radix opens the listbox on keyboard activation, which is deterministic in
    // jsdom (pointer-driven open relies on pointer capture jsdom can't model).
    await user.click(trigger);
    const option = await screen.findByRole("option", { name: "wife" });
    await user.click(option);
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("g1", { relationshipLabel: "wife" });
    });
  });

  it("binds and unbinds a profile through the lifecycle editor", async () => {
    const user = userEvent.setup();
    const unbound = fakeProfile({ id: "g1", entityId: null });
    const bound = fakeProfile({ id: "g1", entityId: "entity-alex" });
    const bind = vi.fn(async () => bound);
    const unbind = vi.fn(async () => unbound);
    const client = makeClient({ bind, unbind });
    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[unbound]}
      />,
    );

    await user.click(screen.getByTestId("voice-profile-manage-g1"));
    const entity = screen.getByTestId("voice-profile-bind-entity-g1");
    const bindLabel = screen.getByTestId("voice-profile-bind-label-g1");
    expect(entity.getAttribute("data-agent-id")).toBe(
      "voice-profile-entity-g1",
    );
    expect(bindLabel.getAttribute("data-agent-id")).toBe(
      "voice-profile-entity-label-g1",
    );
    expect(entity.getAttribute("aria-label")).toBeNull();
    await user.type(entity, "entity-alex");
    await user.type(screen.getByTestId("voice-profile-bind-label-g1"), "Alex");
    await user.click(screen.getByTestId("voice-profile-bind-g1"));

    await waitFor(() => {
      expect(bind).toHaveBeenCalledWith("g1", {
        entityId: "entity-alex",
        label: "Alex",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Bound to entity-alex")).toBeTruthy();
    });

    await user.click(screen.getByTestId("voice-profile-unbind-g1"));
    await waitFor(() => expect(unbind).toHaveBeenCalledWith("g1"));
    await waitFor(() => {
      expect(screen.getByTestId("voice-profile-bind-entity-g1")).toBeTruthy();
    });
  });

  it("splits only a proper subset of retained samples", async () => {
    const user = userEvent.setup();
    const profile = fakeProfile({
      id: "g1",
      entityId: null,
      samples: [
        { id: "s1", durationMs: 1000, recordedAt: "2026-08-01T00:00:00Z" },
        { id: "s2", durationMs: 2000, recordedAt: "2026-08-02T00:00:00Z" },
      ],
    });
    const splitProfile = fakeProfile({ id: "g2", entityId: null });
    const split = vi.fn(async () => ({
      original: { ...profile, samples: profile.samples.slice(1) },
      split: splitProfile,
    }));
    const client = makeClient({ split });
    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[profile]}
      />,
    );

    await user.click(screen.getByTestId("voice-profile-manage-g1"));
    const splitButton = screen.getByTestId(
      "voice-profile-split-g1",
    ) as HTMLButtonElement;
    expect(splitButton.disabled).toBe(true);
    await user.click(screen.getByTestId("voice-profile-split-g1-s1"));
    expect(splitButton.disabled).toBe(false);
    await user.click(screen.getByTestId("voice-profile-split-g1-s2"));
    expect(splitButton.disabled).toBe(true);
    expect(
      screen.getByText("Leave at least one sample in the original profile."),
    ).toBeTruthy();
    await user.click(screen.getByTestId("voice-profile-split-g1-s2"));
    await user.click(splitButton);

    await waitFor(() => {
      expect(split).toHaveBeenCalledWith("g1", { utteranceIds: ["s1"] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("voice-profile-row-g2")).toBeTruthy();
    });
  });

  it("merges a non-owner profile into the chosen destination", async () => {
    const user = userEvent.setup();
    const source = fakeProfile({ id: "source", entityId: null });
    const target = fakeProfile({
      id: "target",
      entityId: null,
      displayName: "Target profile",
    });
    const merged = { ...target, embeddingCount: 6 };
    const merge = vi.fn(async () => merged);
    const client = makeClient({ merge });
    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[source, target]}
      />,
    );

    await user.click(screen.getByTestId("voice-profile-manage-source"));
    const trigger = screen.getByTestId("voice-profile-merge-target-source");
    await user.click(trigger);
    await user.click(
      await screen.findByRole("option", { name: "Target profile" }),
    );
    await user.click(screen.getByTestId("voice-profile-merge-source"));

    await waitFor(() => {
      expect(merge).toHaveBeenCalledWith("source", { intoId: "target" });
    });
    expect(screen.queryByTestId("voice-profile-row-source")).toBeNull();
    expect(screen.getByTestId("voice-profile-row-target")).toBeTruthy();
  });

  it("never exposes owner merge-away or unbind controls", () => {
    const client = makeClient();
    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[
          fakeProfile({
            id: "owner-1",
            isOwner: true,
            cohort: "owner",
            entityId: "owner-entity",
          }),
          fakeProfile({ id: "guest-1" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("voice-profile-manage-owner-1"));
    expect(screen.queryByTestId("voice-profile-merge-owner-1")).toBeNull();
    expect(screen.queryByTestId("voice-profile-unbind-owner-1")).toBeNull();
    expect(screen.getByText("Bound to owner-entity")).toBeTruthy();
  });
});
