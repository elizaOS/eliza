/** Exercises deletion review, uncertain mutation recovery, and duplicate admission through the real React panel. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  FamilyDeletionJob,
  FamilyDeletionPreview,
} from "../../lifeops/family-workflows/deletion-contracts.js";
import type { FamilyDeletionAdapter } from "./deletion-adapter.js";
import { FamilyDeletionPanel } from "./FamilyDeletionPanel.js";

afterEach(cleanup);
function preview(sha256 = "a".repeat(64)): FamilyDeletionPreview {
  return {
    agentId: "agent",
    sha256,
    unavailable: [],
    records: [
      {
        kind: "agreements",
        classification: "owned",
        unsettled: false,
        sha256: "c".repeat(64),
        identity: { id: "agreement", title: "Parenting plan" },
      },
      {
        kind: "calendar",
        classification: "referenced",
        unsettled: false,
        sha256: "d".repeat(64),
        identity: { id: "provider-calendar" },
      },
    ],
  };
}
function job(state: FamilyDeletionJob["state"]): FamilyDeletionJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agentId: "agent",
    reviewedSha256: "a".repeat(64),
    startedAt: "2026-09-13T12:00:00.000Z",
    state,
    backupRetention: "7-days",
    backupGeneration: "22222222-2222-4222-8222-222222222222",
    backupOperationId: "family-delete",
    files: [],
    databaseRowsRemoved: 2,
    retained: [{ kind: "calendar", count: 1 }],
  };
}
function adapter(): FamilyDeletionAdapter {
  return {
    preview: vi.fn(async () => preview()),
    status: vi.fn(async () => null),
    begin: vi.fn(async () => job("backup_pending")),
    resume: vi.fn(async () => job("backup_pending")),
  };
}
async function open() {
  fireEvent.click(
    screen.getByRole("button", { name: "Review workspace deletion" }),
  );
  await screen.findByRole("button", { name: "Delete reviewed workspace" });
}
function confirm() {
  fireEvent.click(screen.getByRole("button", { name: "After 7 days" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Delete reviewed workspace" }),
  );
}
it("requires a fresh complete review and binds confirmation to the refreshed snapshot after rejection", async () => {
  const api = adapter();
  vi.mocked(api.begin).mockRejectedValueOnce(
    new Error("Workspace changed; review again"),
  );
  render(<FamilyDeletionPanel adapter={api} onChange={async () => {}} />);
  await open();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Delete reviewed workspace",
    }).disabled,
  ).toBe(true);
  confirm();
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Delete reviewed workspace" }),
  ).toBeNull();
  vi.mocked(api.preview).mockResolvedValue(preview("b".repeat(64)));
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh deletion status" }),
  );
  await screen.findByRole("checkbox");
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  confirm();
  await screen.findByText(
    /Backup cleanup is pending; deletion is not complete/,
  );
  expect(api.begin).toHaveBeenLastCalledWith({
    expectedSha256: "b".repeat(64),
    backupRetention: "7-days",
  });
});
it("does not dispatch while dependency review is incomplete or work is unsettled", async () => {
  const api = adapter();
  const incomplete = preview();
  incomplete.unavailable = ["agreements"];
  incomplete.records[0].unsettled = true;
  vi.mocked(api.preview).mockResolvedValue(incomplete);
  render(<FamilyDeletionPanel adapter={api} onChange={async () => {}} />);
  await open();
  confirm();
  expect(api.begin).not.toHaveBeenCalled();
  expect(screen.getByText(/Review is incomplete/)).toBeTruthy();
  expect(screen.getByText(/Work is still in progress/)).toBeTruthy();
});
it("prevents duplicate admission and reloads the durable pending job for recovery", async () => {
  const api = adapter();
  let settle: (value: FamilyDeletionJob) => void = () => {
    throw new Error("request not started");
  };
  vi.mocked(api.begin).mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const mounted = render(
    <FamilyDeletionPanel adapter={api} onChange={async () => {}} />,
  );
  await open();
  confirm();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete reviewed workspace" }),
  );
  expect(api.begin).toHaveBeenCalledTimes(1);
  settle(job("purge_pending"));
  await screen.findByText(/Primary-file cleanup is still pending/);
  mounted.unmount();
  vi.mocked(api.status).mockResolvedValue(job("purge_pending"));
  vi.mocked(api.resume).mockRejectedValueOnce(
    new Error("Cleanup acknowledgement lost"),
  );
  render(<FamilyDeletionPanel adapter={api} onChange={async () => {}} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Review workspace deletion" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry primary cleanup" }),
  );
  await screen.findByText("Cleanup acknowledgement lost");
  fireEvent.click(
    screen.getByRole("button", { name: "Retry primary cleanup" }),
  );
  await screen.findByText(
    /Backup cleanup is pending; deletion is not complete/,
  );
  await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(2));
  expect(api.begin).toHaveBeenCalledTimes(1);
});
