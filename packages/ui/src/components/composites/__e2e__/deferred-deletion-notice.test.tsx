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
import { Profiler } from "react";
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
  // The follow-up refresh succeeds and must not clear the failed Undo result.
  expect(fake.undo).toHaveBeenCalledTimes(1);
  expect(fake.pending.mock.calls.length).toBeGreaterThan(1);
  expect(screen.getByRole("status").textContent).toBe(UNDO_TOO_LATE);
  fake.undo.mockRejectedValueOnce(new Error("lost"));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await flush();
  expect(screen.getByRole("status").textContent).toBe(
    DELETION_NOTICE_TEXT.undoUnconfirmed,
  );
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function ownerIdentity() {
  let owner = "owner-A";
  const listeners = new Set<() => void>();
  return {
    read: () => owner,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    change: (next: string) => {
      owner = next;
      for (const listener of listeners) listener();
    },
  };
}

it.each(["late receipt", "rejection"])(
  "ignores an old owner's held Undo %s without refreshing the successor",
  async (outcome) => {
    const fake = bridge([row("same-id", "queued", "open")]);
    const held = deferred<{ phase: string }>();
    fake.undo.mockImplementationOnce(() => held.promise);
    const identity = ownerIdentity();
    const onChanged = vi.fn();
    render(
      <DeferredDeletionNotice
        bridge={fake}
        identity={identity}
        onChanged={onChanged}
        pollMs={60_000}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await act(async () => identity.change("owner-B"));
    expect(fake.pending).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (outcome === "rejection")
        held.reject(new Error("old owner's failure"));
      else held.resolve({ phase: "deleted" });
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(fake.pending).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Event same-id")).toBeTruthy();
  },
);

it.each(["acknowledged", "rejected"])(
  "does not apply an old owner's %s dismissal to a successor with the same record key",
  async (outcome) => {
    const fake = bridge([row("same-id", "unknown")]);
    const held = deferred<{ status: string }>();
    fake.dismiss.mockImplementationOnce(() => held.promise);
    const identity = ownerIdentity();
    const onChanged = vi.fn();
    render(
      <DeferredDeletionNotice
        bridge={fake}
        identity={identity}
        onChanged={onChanged}
        pollMs={60_000}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss outcome" }));
    await act(async () => identity.change("owner-B"));
    await act(async () => {
      if (outcome === "rejected") held.reject(new Error("old owner's failure"));
      else held.resolve({ status: "acknowledged" });
    });
    expect(screen.getByText("Event same-id")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(fake.pending).toHaveBeenCalledTimes(2);
  },
);

it("keeps a successor's held action busy when the old owner's action settles", async () => {
  const fake = bridge([row("same-id", "queued", "open")]);
  const oldAction = deferred<{ phase: string }>();
  const newAction = deferred<{ phase: string }>();
  fake.undo
    .mockImplementationOnce(() => oldAction.promise)
    .mockImplementationOnce(() => newAction.promise);
  const identity = ownerIdentity();
  const onChanged = vi.fn();
  render(
    <DeferredDeletionNotice
      bridge={fake}
      identity={identity}
      onChanged={onChanged}
      pollMs={60_000}
    />,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(
    (screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => identity.change("owner-B"));
  const successor = screen.getByRole("button", {
    name: "Undo",
  }) as HTMLButtonElement;
  expect(successor.disabled).toBe(false);
  fireEvent.click(successor);
  expect(fake.undo).toHaveBeenCalledTimes(2);
  expect(successor.disabled).toBe(true);
  await act(async () => oldAction.resolve({ phase: "deleted" }));
  expect(successor.disabled).toBe(true);
  expect(screen.queryByRole("status")).toBeNull();
  expect(onChanged).not.toHaveBeenCalled();
  expect(fake.pending).toHaveBeenCalledTimes(2);
  await act(async () => newAction.resolve({ phase: "undone" }));
  expect(successor.disabled).toBe(false);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(fake.pending).toHaveBeenCalledTimes(3);
});

it("ignores a held action when its bridge is replaced without an identity change", async () => {
  const oldBridge = bridge([row("a", "queued", "open")]);
  const newBridge = bridge([row("b", "queued", "open")]);
  const held = deferred<{ phase: string }>();
  oldBridge.undo.mockImplementationOnce(() => held.promise);
  const identity = ownerIdentity();
  const onChanged = vi.fn();
  const view = render(
    <DeferredDeletionNotice
      bridge={oldBridge}
      identity={identity}
      onChanged={onChanged}
      pollMs={60_000}
    />,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  view.rerender(
    <DeferredDeletionNotice
      bridge={newBridge}
      identity={identity}
      onChanged={onChanged}
      pollMs={60_000}
    />,
  );
  await act(async () => held.resolve({ phase: "deleted" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(onChanged).not.toHaveBeenCalled();
  expect(newBridge.pending).not.toHaveBeenCalled();
});

it("preserves the current owner's dismissal failure and permits a later action", async () => {
  const fake = bridge([row("a", "unknown")]);
  fake.dismiss.mockRejectedValueOnce(new Error("current owner's failure"));
  render(<DeferredDeletionNotice bridge={fake} pollMs={60_000} />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss outcome" }));
  await flush();
  expect(screen.getByRole("status").textContent).toBe(
    DELETION_NOTICE_TEXT.dismissFailed,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Dismiss outcome",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss outcome" }));
  await flush();
  expect(fake.dismiss).toHaveBeenCalledTimes(2);
});

it("does not readmit an old action when the owner key returns to its previous value", async () => {
  const fake = bridge([row("a", "queued", "open")]);
  const held = deferred<{ phase: string }>();
  fake.undo.mockImplementationOnce(() => held.promise);
  const identity = ownerIdentity();
  const onChanged = vi.fn();
  render(
    <DeferredDeletionNotice
      bridge={fake}
      identity={identity}
      onChanged={onChanged}
      pollMs={60_000}
    />,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await act(async () => identity.change("owner-B"));
  await act(async () => identity.change("owner-A"));
  await act(async () => held.resolve({ phase: "deleted" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(onChanged).not.toHaveBeenCalled();
  expect(fake.pending).toHaveBeenCalledTimes(3);
});

it("does not refresh the host after a held action completes on an unmounted notice", async () => {
  const fake = bridge([row("a", "unknown")]);
  const held = deferred<{ status: string }>();
  fake.dismiss.mockImplementationOnce(() => held.promise);
  const onChanged = vi.fn();
  const view = render(
    <DeferredDeletionNotice
      bridge={fake}
      onChanged={onChanged}
      pollMs={60_000}
    />,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss outcome" }));
  view.unmount();
  await act(async () => held.resolve({ status: "acknowledged" }));
  expect(onChanged).not.toHaveBeenCalled();
  expect(fake.pending).toHaveBeenCalledTimes(1);
});

it("settles current-owner busy state while concealed without leaving the returning notice locked", async () => {
  const fake = bridge([row("a", "queued", "open")]);
  const held = deferred<{ phase: string }>();
  fake.undo.mockImplementationOnce(() => held.promise);
  let concealed = false;
  render(
    <DeferredDeletionNotice
      bridge={fake}
      concealed={() => concealed}
      refreshEvents={["test:refresh"]}
      pollMs={60_000}
    />,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  concealed = true;
  await act(async () => window.dispatchEvent(new Event("test:refresh")));
  await act(async () => held.resolve({ phase: "undone" }));
  concealed = false;
  await act(async () => window.dispatchEvent(new Event("test:refresh")));
  expect(
    (screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("rejects a pending read from the replaced bridge before displaying its rows", async () => {
  const previous = bridge([]);
  const successor = bridge([row("successor", "queued", "open")]);
  const held = deferred<{ deletions: DeferredDeletionEntry[] }>();
  previous.pending.mockImplementationOnce(() => held.promise);
  const view = render(
    <DeferredDeletionNotice
      bridge={previous}
      refreshEvents={["test:refresh"]}
      pollMs={60_000}
    />,
  );
  view.rerender(
    <DeferredDeletionNotice
      bridge={successor}
      refreshEvents={["test:refresh"]}
      pollMs={60_000}
    />,
  );
  await act(async () =>
    held.resolve({ deletions: [row("old", "queued", "open")] }),
  );
  expect(screen.queryByText("Event old")).toBeNull();
  await act(async () => window.dispatchEvent(new Event("test:refresh")));
  expect(screen.getByText("Event successor")).toBeTruthy();
});

it("rejects a pending read when the owner changes before its subscription notifies", async () => {
  const fake = bridge([]);
  const held = deferred<{ deletions: DeferredDeletionEntry[] }>();
  fake.pending.mockImplementationOnce(() => held.promise);
  let owner = "owner-A";
  const identity = { read: () => owner, subscribe: () => () => {} };
  render(
    <DeferredDeletionNotice
      bridge={fake}
      identity={identity}
      pollMs={60_000}
    />,
  );
  owner = "owner-B";
  await act(async () =>
    held.resolve({ deletions: [row("old", "queued", "open")] }),
  );
  expect(screen.queryByText("Event old")).toBeNull();
});

it("does not dispatch a displayed old row through a replacement bridge", async () => {
  const previous = bridge([row("old", "queued", "open")]);
  const successor = bridge([row("successor", "queued", "open")]);
  const view = render(
    <DeferredDeletionNotice bridge={previous} pollMs={60_000} />,
  );
  await flush();
  const oldButton = screen.getByRole("button", { name: "Undo" });
  view.rerender(<DeferredDeletionNotice bridge={successor} pollMs={60_000} />);
  fireEvent.click(oldButton);
  await flush();
  expect(successor.undo).not.toHaveBeenCalled();
  expect(previous.undo).not.toHaveBeenCalled();
  expect(screen.queryByText("Event old")).toBeNull();
});

it.each(["Undo", "Dismiss outcome"])(
  "does not dispatch displayed %s after an unnotified owner change",
  async (button) => {
    const fake = bridge([
      row("old", button === "Undo" ? "queued" : "unknown", "open"),
    ]);
    let owner = "owner-A";
    const identity = { read: () => owner, subscribe: () => () => {} };
    render(
      <DeferredDeletionNotice
        bridge={fake}
        identity={identity}
        pollMs={60_000}
      />,
    );
    await flush();
    owner = "owner-B";
    fireEvent.click(screen.getByRole("button", { name: button }));
    await flush();
    expect(fake.undo).not.toHaveBeenCalled();
    expect(fake.dismiss).not.toHaveBeenCalled();
  },
);

it("retires displayed rows before waiting for a read under an unnotified successor owner", async () => {
  const fake = bridge([row("old", "queued", "open")]);
  let owner = "owner-A";
  const identity = { read: () => owner, subscribe: () => () => {} };
  render(
    <DeferredDeletionNotice
      bridge={fake}
      identity={identity}
      refreshEvents={["test:refresh"]}
      pollMs={60_000}
    />,
  );
  await flush();
  expect(screen.getByText("Event old")).toBeTruthy();
  const held = deferred<{ deletions: DeferredDeletionEntry[] }>();
  fake.pending.mockImplementationOnce(() => held.promise);
  owner = "owner-B";
  await act(async () => window.dispatchEvent(new Event("test:refresh")));
  expect(screen.queryByText("Event old")).toBeNull();
  await act(async () =>
    held.resolve({ deletions: [row("successor", "queued", "open")] }),
  );
  expect(screen.getByText("Event successor")).toBeTruthy();
});

it("keeps current-owner cached rows in place during an ordinary held refresh", async () => {
  const fake = bridge([row("current", "queued", "open")]);
  const commits = vi.fn();
  render(
    <Profiler id="notice" onRender={commits}>
      <DeferredDeletionNotice
        bridge={fake}
        refreshEvents={["test:refresh"]}
        pollMs={60_000}
      />
    </Profiler>,
  );
  await flush();
  const cachedRow = screen.getByText("Event current");
  const undo = screen.getByRole("button", { name: "Undo" });
  const held = deferred<{ deletions: DeferredDeletionEntry[] }>();
  fake.pending.mockImplementationOnce(() => held.promise);
  const committedBeforePoll = commits.mock.calls.length;
  await act(async () => window.dispatchEvent(new Event("test:refresh")));
  expect(commits).toHaveBeenCalledTimes(committedBeforePoll);
  expect(screen.getByText("Event current")).toBe(cachedRow);
  expect(screen.getByRole("button", { name: "Undo" })).toBe(undo);
  expect((undo as HTMLButtonElement).disabled).toBe(false);
  await act(async () =>
    held.resolve({ deletions: [row("current", "queued", "open")] }),
  );
  expect(screen.getByText("Event current")).toBe(cachedRow);
});
