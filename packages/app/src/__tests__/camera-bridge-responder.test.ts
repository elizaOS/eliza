import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startCameraBridgeResponder } from "../camera-bridge-responder";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Encoding: { UTF8: "utf8" },
  Filesystem: mocks,
}));
vi.mock("@elizaos/ui/logger", () => ({
  logger: { warn: mocks.warn, info: vi.fn() },
}));

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

it("serializes request reads and suppresses capture after stop", async () => {
  let complete!: (result: { data: string }) => void;
  mocks.readFile.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  stop = startCameraBridgeResponder();
  expect(startCameraBridgeResponder()).toBe(stop);
  await vi.advanceTimersByTimeAsync(1_200);
  expect(mocks.readFile).toHaveBeenCalledTimes(1);
  stop();
  complete({ data: "capture-1" });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.writeFile).not.toHaveBeenCalled();
  expect(mocks.mkdir).not.toHaveBeenCalled();
});

it("reports filesystem failures instead of treating them as an idle request", async () => {
  mocks.readFile.mockRejectedValue({ code: "OS-PLUG-FILE-0007" });
  stop = startCameraBridgeResponder();
  await vi.advanceTimersByTimeAsync(400);
  expect(mocks.warn).toHaveBeenCalled();
});

it("treats a missing request as the expected idle state", async () => {
  mocks.readFile.mockRejectedValue({ code: "OS-PLUG-FILE-0008" });
  stop = startCameraBridgeResponder();
  await vi.advanceTimersByTimeAsync(400);
  expect(mocks.warn).not.toHaveBeenCalled();
});
