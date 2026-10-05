// @vitest-environment jsdom
import type { TaskChoiceWidget } from "@elizaos/core/protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskChoice } from "./TaskChoice";

function widget(overrides: Partial<TaskChoiceWidget> = {}): TaskChoiceWidget {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    epoch: 0,
    contextKey: "a".repeat(64),
    callbackData: `is1:${"b".repeat(32)}`,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    state: "pending",
    block: {
      kind: "choice",
      id: "method",
      scope: "task",
      prompt: "Choose a method",
      options: [{ value: "saved", label: "Existing method" }],
    },
    ...overrides,
  };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("locks duplicate clicks and ignores failure from a replaced widget", async () => {
  let reject!: (error: Error) => void;
  const first = new Promise<void>((_, r) => {
    reject = r;
  });
  let calls = 0;
  const choose = () => {
    calls++;
    return first;
  };
  const view = render(
    <TaskChoice widget={widget()} taskId="task-1" onChoose={choose} />,
  );
  fireEvent.click(screen.getByRole("button"));
  fireEvent.click(screen.getByRole("button"));
  expect(calls).toBe(1);
  view.rerender(
    <TaskChoice
      widget={widget({ callbackData: `is1:${"c".repeat(32)}` })}
      taskId="task-1"
      onChoose={async () => {
        calls++;
      }}
    />,
  );
  await act(async () => {
    reject(new Error("old request"));
    await first.catch(() => {});
  });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  await act(async () => {});
  expect(calls).toBe(2);
});
it("checks the real deadline when expiry timer has not fired", () => {
  vi.useFakeTimers();
  const now = Date.now();
  vi.setSystemTime(now);
  let calls = 0;
  render(
    <TaskChoice
      widget={widget({ expiresAt: new Date(now + 1000).toISOString() })}
      taskId="task-1"
      onChoose={async () => {
        calls++;
      }}
    />,
  );
  vi.setSystemTime(now + 2000);
  fireEvent.click(screen.getByRole("button"));
  expect(calls).toBe(0);
});
it("uses host text for a failed request and allows deliberate retry", async () => {
  let calls = 0;
  render(
    <TaskChoice
      widget={widget()}
      taskId="task-1"
      messages={{ failed: "Connection lost. Retry this choice." }}
      onChoose={async () => {
        if (++calls === 1) throw new Error("offline");
      }}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button"));
  });
  expect(screen.getByRole("alert").textContent).toBe(
    "Connection lost. Retry this choice.",
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button"));
  });
  expect(calls).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("hides another task and never resubmits a committed choice", () => {
  let calls = 0;
  const view = render(
    <TaskChoice
      widget={widget()}
      taskId="other"
      onChoose={async () => {
        calls++;
      }}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    <TaskChoice
      widget={widget({ state: "committed" })}
      taskId="task-1"
      messages={{ received: "Received by the service." }}
      onChoose={async () => {
        calls++;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(calls).toBe(0);
  expect(screen.getByRole("status").textContent).toBe(
    "Received by the service.",
  );
});
it("keeps disabling unavailable options by default", () => {
  const view = render(
    <TaskChoice
      widget={widget()}
      taskId="task-1"
      pending
      onChoose={async () => {}}
    />,
  );
  const button = screen.getByRole("button") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-disabled")).toBeNull();
  view.rerender(
    <TaskChoice
      widget={widget({ state: "committed" })}
      taskId="task-1"
      onChoose={async () => {}}
    />,
  );
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe(
    "Your choice was received.",
  );
});
it("explains an in-flight choice without dispatching it twice", async () => {
  let resolve!: () => void;
  const first = new Promise<void>((r) => {
    resolve = r;
  });
  let calls = 0;
  render(
    <TaskChoice
      explainUnavailable
      widget={widget()}
      taskId="task-1"
      messages={{ checking: "Still checking your choice." }}
      onChoose={() => {
        calls++;
        return first;
      }}
    />,
  );
  const button = screen.getByRole("button") as HTMLButtonElement;
  fireEvent.click(button);
  expect(screen.queryByRole("status")).toBeNull();
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(calls).toBe(1);
  expect(screen.getByRole("status").textContent).toBe(
    "Still checking your choice.",
  );
  await act(async () => {
    resolve();
    await first;
  });
  expect(screen.queryByRole("status")).toBeNull();
  expect(button.getAttribute("aria-disabled")).toBeNull();
});
it("announces the checking notice outside the busy options", async () => {
  let resolve!: () => void;
  const first = new Promise<void>((r) => {
    resolve = r;
  });
  render(
    <TaskChoice
      explainUnavailable
      widget={widget()}
      taskId="task-1"
      onChoose={() => first}
    />,
  );
  const button = screen.getByRole("button");
  fireEvent.click(button);
  fireEvent.click(button);
  // The notice only exists while busy; inside an aria-busy subtree it could
  // be held back until it is already gone.
  expect(button.closest('[aria-busy="true"]')).toBe(button);
  expect(screen.getByRole("status").closest('[aria-busy="true"]')).toBeNull();
  await act(async () => {
    resolve();
    await first;
  });
  expect(button.closest('[aria-busy="true"]')).toBeNull();
});
it("explains a host-pending choice with the default text", () => {
  let calls = 0;
  render(
    <TaskChoice
      explainUnavailable
      widget={widget()}
      taskId="task-1"
      pending
      onChoose={async () => {
        calls++;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(calls).toBe(0);
  expect(screen.getByRole("status").textContent).toBe(
    "Your choice is being checked. Please wait for the result.",
  );
});
it("announces expiry on activation before the expiry timer fires", () => {
  vi.useFakeTimers();
  const now = Date.now();
  vi.setSystemTime(now);
  let calls = 0;
  render(
    <TaskChoice
      explainUnavailable
      widget={widget({ expiresAt: new Date(now + 1000).toISOString() })}
      taskId="task-1"
      expiredMessage="This choice expired. Resume the task to review again."
      onChoose={async () => {
        calls++;
      }}
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  vi.setSystemTime(now + 2000);
  fireEvent.click(screen.getByRole("button"));
  fireEvent.click(screen.getByRole("button"));
  expect(calls).toBe(0);
  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(1);
  expect(statuses[0]?.textContent).toBe(
    "This choice expired. Resume the task to review again.",
  );
  expect(
    (screen.getByRole("button") as HTMLButtonElement).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
});
it("hides options of a received choice when explaining unavailability", () => {
  render(
    <TaskChoice
      explainUnavailable
      widget={widget({ state: "committed" })}
      taskId="task-1"
      messages={{ received: "Received by the service." }}
      onChoose={async () => {}}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe(
    "Received by the service.",
  );
});
