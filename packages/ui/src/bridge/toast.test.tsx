/** Exercises native Cloud feedback and real Sonner interactive fallback behavior in jsdom. */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { Toaster } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { deliver, sink } = vi.hoisted(() => ({
  deliver: vi.fn(),
  sink: vi.fn(),
}));
vi.mock("./notification-delivery", () => ({
  deliverSystemNotification: deliver,
}));
vi.mock("./electrobun-runtime", () => ({ isElectrobunRuntime: () => true }));
vi.mock("../state/app-store", () => ({ getActionNoticeSink: sink }));

import { useLifecycleState } from "../state/useLifecycleState";
import { toast } from "./toast";

beforeEach(() => {
  deliver.mockReset();
  sink.mockReturnValue(null);
});
afterEach(() => {
  toast.dismiss();
  cleanup();
});

it("does not duplicate OS-accepted feedback in the Cloud viewport", async () => {
  deliver.mockResolvedValue("desktop");
  render(<Toaster />);
  await act(async () => {
    toast.success("Deployment complete");
  });
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({ body: "Deployment complete" }),
  );
  expect(screen.queryByText("Deployment complete")).toBeNull();
});

it("renders native-unavailable feedback using the real Cloud fallback", async () => {
  deliver.mockResolvedValue("none");
  render(<Toaster />);
  await act(async () => {
    toast.error("Deployment failed");
  });
  expect(await screen.findByText("Deployment failed")).toBeTruthy();
});

it("keeps an Undo action executable in the app instead of losing it in an OS alert", async () => {
  const undo = vi.fn();
  render(<Toaster />);
  await act(async () => {
    toast("Removed item", { action: { label: "Undo", onClick: undo } });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(undo).toHaveBeenCalledTimes(1);
  expect(deliver).not.toHaveBeenCalled();
});

it("does not display a dismissed fallback when the OS request settles late", async () => {
  let finish: (channel: string) => void = () => {
    throw new Error("not started");
  };
  deliver.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  render(<Toaster />);
  await act(async () => {
    const id = toast("Cancelled notice");
    toast.dismiss(id);
    finish("none");
  });
  expect(screen.queryByText("Cancelled notice")).toBeNull();
});

it("shares the real shell owner and dismisses its fallback without a second OS dispatch", async () => {
  deliver.mockResolvedValue("none");
  const { result } = renderHook(() => useLifecycleState());
  sink.mockReturnValue(result.current.setActionNotice);
  let id: number | string = "unassigned";
  await act(async () => {
    id = toast.success("Account saved");
  });
  expect(result.current.state.actionNotice?.text).toBe("Account saved");
  expect(deliver).toHaveBeenCalledTimes(1);
  act(() => {
    toast.dismiss(id);
  });
  expect(result.current.state.actionNotice).toBeNull();
});
