// @vitest-environment jsdom
/** The shared Undo notice over a synthetic pending-deletion bridge. */
import {
  DELETION_NOTICE_TEXT,
  type DeferredDeletionEntry,
  UNDO_TOO_LATE,
} from "@elizaos/contracts/deletion-window";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeferredDeletionNotice } from "../deferred-deletion-notice";

afterEach(cleanup);

const row = (
  id: string,
  phase: string,
  window?: string,
  kind = "calendar",
): DeferredDeletionEntry => ({
  id,
  kind,
  phase,
  window,
  target: { fields: { title: `Event ${id}` } },
});

const flush = () => act(async () => {});

function bridge(rows: DeferredDeletionEntry[]) {
  return {
    pending: vi.fn(async () => ({ deletions: rows.slice() })),
    undo: vi.fn(async (_input: { kind: string; id: string }) => ({
      phase: "undone",
    })),
    dismiss: vi.fn(async (_input: { kind: string; id: string }) => ({
      status: "acknowledged",
    })),
  };
}

it("shows only pending rows, offers Undo inside the window and refreshes record views after Undo", async () => {
  const fake = bridge([
    row("open", "queued", "open"),
    row("late", "queued", "expired"),
    row("gone", "deleted"),
  ]);
  const onChanged = vi.fn();
  render(
    <DeferredDeletionNotice
      bridge={fake}
      onChanged={onChanged}
      pollMs={60_000}
    />,
  );
  await flush();
  expect(screen.getByLabelText("Pending deletions")).toBeTruthy();
  expect(screen.getByText("Event open")).toBeTruthy();
  expect(screen.getByText("Event late")).toBeTruthy();
  expect(screen.queryByText("Event gone")).toBeNull();
  const undo = screen.getAllByRole("button", { name: "Undo" });
  expect(undo).toHaveLength(1);
  fireEvent.click(undo[0]);
  await flush();
  expect(fake.undo).toHaveBeenCalledWith({ kind: "calendar", id: "open" });
  expect(onChanged).toHaveBeenCalled();
});

it("never reports a settled deletion as kept", async () => {
  const fake = bridge([row("a", "queued", "open")]);
  fake.undo.mockResolvedValueOnce({ phase: "deleted" });
  render(<DeferredDeletionNotice bridge={fake} pollMs={60_000} />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  // The follow-up refresh may clear the message once the receipt is read again.
  expect(fake.undo).toHaveBeenCalledTimes(1);
  fake.undo.mockRejectedValueOnce(new Error("lost"));
  fake.pending.mockRejectedValue(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  expect(screen.getByRole("status").textContent).toBe(
    DELETION_NOTICE_TEXT.undoUnconfirmed,
  );
  expect(UNDO_TOO_LATE).toMatch(/already went ahead/);
});

it("an uncertain outcome is refreshed or dismissed, never undone or repeated", async () => {
  const fake = bridge([
    row("u", "unknown"),
    row("d", "dispatching", undefined, "reminder"),
  ]);
  render(<DeferredDeletionNotice bridge={fake} pollMs={60_000} />);
  await flush();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.getAllByText(DELETION_NOTICE_TEXT.uncertain)).toHaveLength(2);
  fireEvent.click(
    screen.getAllByRole("button", { name: "Dismiss outcome" })[0],
  );
  await flush();
  expect(fake.dismiss).toHaveBeenCalledWith({ kind: "calendar", id: "u" });
  expect(fake.undo).not.toHaveBeenCalled();
});

it("hides rows while concealed and clears them when the owner changes", async () => {
  const fake = bridge([row("a", "queued", "open")]);
  let hidden = true;
  let owner = "owner-A";
  const listeners = new Set<() => void>();
  const identity = {
    read: () => owner,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  render(
    <DeferredDeletionNotice
      bridge={fake}
      identity={identity}
      concealed={() => hidden}
      refreshEvents={["test:deletions-changed"]}
      pollMs={60_000}
    />,
  );
  await flush();
  expect(fake.pending).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Pending deletions")).toBeNull();
  hidden = false;
  await act(async () => {
    window.dispatchEvent(new Event("test:deletions-changed"));
  });
  expect(screen.getByText("Event a")).toBeTruthy();
  let release!: () => void;
  fake.pending.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ deletions: [row("b", "queued", "open")] });
      }),
  );
  owner = "owner-B";
  await act(async () => {
    for (const listener of listeners) listener();
  });
  expect(screen.queryByText("Event a")).toBeNull();
  await act(async () => release());
  expect(screen.getByText("Event b")).toBeTruthy();
});

it("reports unavailable status only after repeated failures", async () => {
  const fake = bridge([]);
  fake.pending.mockRejectedValue(new Error("offline"));
  render(
    <DeferredDeletionNotice
      bridge={fake}
      refreshEvents={["test:refresh"]}
      pollMs={60_000}
    />,
  );
  await flush();
  await act(async () => {
    window.dispatchEvent(new Event("test:refresh"));
  });
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => {
    window.dispatchEvent(new Event("test:refresh"));
  });
  expect(screen.getByRole("status").textContent).toBe(
    DELETION_NOTICE_TEXT.statusUnavailable,
  );
});
