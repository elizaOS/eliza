/**
 * Deterministic unit coverage for the issue-creation degrade seams added after
 * the 2026-08-10 live incident: labels apply as a best-effort second step so a
 * label-permission failure cannot kill the creation, and issue-op failures
 * speak an in-voice line instead of raw provider JSON. Stubbed service, no
 * network.
 */
import { describe, expect, it, vi } from "vitest";
import { createIssueWithBestEffortLabels, issueFailureReply } from "./tasks";

const ISSUE = {
  number: 7,
  title: "planner leaked internal json",
  url: "https://github.com/o/r/issues/7",
  state: "open" as const,
  labels: [],
  body: "",
};

function stubService(overrides?: { addLabels?: () => Promise<void> }) {
  return {
    createIssue: vi.fn(async () => ISSUE),
    addLabels: vi.fn(overrides?.addLabels ?? (async () => undefined)),
  } as never;
}

describe("createIssueWithBestEffortLabels", () => {
  it("creates without labels in the create call and applies them separately", async () => {
    const service = stubService();
    const { issue, labelNote } = await createIssueWithBestEffortLabels(
      service,
      "o/r",
      { title: ISSUE.title, body: "b", labels: ["bug"] },
    );
    expect(issue.number).toBe(7);
    expect(labelNote).toBe("");
    const createArgs = (service as { createIssue: ReturnType<typeof vi.fn> })
      .createIssue.mock.calls[0];
    // The create call itself must never carry labels — that is what a
    // read-tier token 403s on, killing the whole creation.
    expect(JSON.stringify(createArgs)).not.toContain("labels");
    expect(
      (service as { addLabels: ReturnType<typeof vi.fn> }).addLabels,
    ).toHaveBeenCalledWith("o/r", 7, ["bug"]);
  });

  it("a label-permission failure degrades to a note; the issue still exists", async () => {
    const service = stubService({
      addLabels: async () => {
        throw new Error(
          'You do not have permission to create labels on this repository.: {"resource":"Repository","field":"label","code":"unauthorized"}',
        );
      },
    });
    const { issue, labelNote } = await createIssueWithBestEffortLabels(
      service,
      "o/r",
      { title: ISSUE.title, body: "b", labels: ["bug"] },
    );
    expect(issue.number).toBe(7);
    expect(labelNote).toContain("labels skipped");
  });

  it("skips the label step entirely when no labels were requested", async () => {
    const service = stubService();
    await createIssueWithBestEffortLabels(service, "o/r", {
      title: ISSUE.title,
      body: "b",
      labels: [],
    });
    expect(
      (service as { addLabels: ReturnType<typeof vi.fn> }).addLabels,
    ).not.toHaveBeenCalled();
  });
});

describe("issueFailureReply", () => {
  it("permission failures get a human line with no API payload", () => {
    const reply = issueFailureReply(
      "elizaOS/eliza",
      'You do not have permission to create labels on this repository.: {"resource":"Repository","field":"label","code":"unauthorized"} - https://docs.github.com/v3/issues/labels/',
    );
    expect(reply).toContain("doesn't have permission");
    expect(reply).not.toContain("{");
    expect(reply).not.toContain("docs.github.com");
  });

  it("not-found and generic failures stay in voice too", () => {
    expect(issueFailureReply("o/r", "Not Found - 404")).toContain(
      "doesn't exist",
    );
    expect(issueFailureReply("o/r", "socket hang up")).toContain(
      "Couldn't finish",
    );
  });
});
