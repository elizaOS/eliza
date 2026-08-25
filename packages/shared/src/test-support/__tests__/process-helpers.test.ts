import { describe, expect, it } from "vitest";
import { createMockChildProcess } from "../process-helpers.ts";

describe("createMockChildProcess", () => {
  it("emits close with the exit code", async () => {
    const child = createMockChildProcess({ exitCode: 7 });
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (c) => resolve(c));
    });
    expect(code).toBe(7);
  });

  it("emits error instead of close when configured", async () => {
    const boom = new Error("spawn failed");
    const child = createMockChildProcess({ exitCode: 1, emitError: boom });
    const err = await new Promise<Error | null>((resolve) => {
      child.on("error", (e) => resolve(e as Error));
      child.on("close", () => resolve(null));
    });
    expect(err).toBe(boom);
  });

  it("emits stderr data before close", async () => {
    const child = createMockChildProcess({
      exitCode: 2,
      stderrOutput: "boom message",
    });
    const chunks: Buffer[] = [];
    child.stderr?.on("data", (d: Buffer) => chunks.push(d));
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(Buffer.concat(chunks).toString()).toBe("boom message");
  });
});
