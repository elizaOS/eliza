import { describe, expect, it, vi } from "vitest";
import { prepareDevtoolsOpen } from "./devtools-layout";

describe("prepareDevtoolsOpen", () => {
  it("forces the durable detached inspector preference on macOS only", () => {
    const prepareDetached = vi.fn();

    prepareDevtoolsOpen("darwin", prepareDetached);
    prepareDevtoolsOpen("linux", prepareDetached);
    prepareDevtoolsOpen("win32", prepareDetached);

    expect(prepareDetached).toHaveBeenCalledTimes(1);
  });
});
