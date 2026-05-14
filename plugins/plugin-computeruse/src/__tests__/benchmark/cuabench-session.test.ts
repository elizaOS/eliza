import { describe, expect, it, vi } from "vitest";
import { CuaBenchSession } from "../../benchmarks/cuabench-session.js";
import type { CuaBenchServiceLike } from "../../benchmarks/cuabench-session.js";

function makeService(): CuaBenchServiceLike & {
  executeCommand: ReturnType<typeof vi.fn>;
  executeDesktopAction: ReturnType<typeof vi.fn>;
} {
  return {
    executeCommand: vi.fn(async (command: string, params?: Record<string, unknown>) => {
      if (command === "file_exists") {
        return { success: true, exists: params?.path === "/tmp/exists" };
      }
      if (command === "file_read") {
        return { success: true, content: "file-content" };
      }
      return { success: true, output: "ok" };
    }),
    executeDesktopAction: vi.fn(async (params) => ({
      success: true,
      screenshot: params.action === "screenshot" ? "png-b64" : undefined,
    })),
  };
}

describe("CuaBenchSession", () => {
  it("executes CuaBench desktop actions through ComputerUseService", async () => {
    const service = makeService();
    const session = new CuaBenchSession(service);

    await expect(session.executeAction("middle_click(5, 6)")).resolves.toMatchObject({
      success: true,
    });
    expect(service.executeDesktopAction).toHaveBeenCalledWith({
      action: "middle_click",
      coordinate: [5, 6],
    });
  });

  it("supports screenshot, file, command, and control helpers", async () => {
    const service = makeService();
    const session = new CuaBenchSession(service);

    await expect(session.screenshot()).resolves.toBe("png-b64");
    await expect(session.fileExists("/tmp/exists")).resolves.toBe(true);
    await expect(session.readFile("/tmp/file")).resolves.toBe("file-content");
    await expect(session.runCommand("echo ok")).resolves.toMatchObject({
      success: true,
      output: "ok",
    });
    await expect(session.executeAction("done()")).resolves.toMatchObject({
      success: true,
      done: true,
    });
  });
});
