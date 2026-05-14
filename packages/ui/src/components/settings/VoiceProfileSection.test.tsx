// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceProfilesClient, type VoiceProfile } from "../../api/client-voice-profiles";
import { VoiceProfileSection } from "./VoiceProfileSection";

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
    ...over,
  };
}

function makeClient(overrides?: Partial<VoiceProfilesClient>) {
  const base = new VoiceProfilesClient({
    fetch: async () => ({ profiles: [] }),
  });
  // shallow-replace only requested methods.
  return Object.assign(base, overrides);
}

describe("VoiceProfileSection", () => {
  it("renders OWNER pinned at top + Crown badge", () => {
    const client = makeClient();
    const profiles: VoiceProfile[] = [
      fakeProfile({ id: "guest-1", displayName: "Unknown A", lastHeardAtMs: 5 }),
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
    expect(screen.getByTestId("voice-profile-name-g1").textContent).toBe(
      "New name",
    );
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
    const patch = vi.fn(async () => {});
    const client = makeClient({ patch });
    render(
      <VoiceProfileSection
        profilesClient={client}
        initialProfiles={[fakeProfile({ id: "g1" })]}
      />,
    );

    const select = screen.getByTestId(
      "voice-profile-relationship-select-g1",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "wife" } });
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("g1", { relationshipLabel: "wife" });
    });
  });
});
