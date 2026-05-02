import { describe, expect, test } from "vitest";

describe("runner module", () => {
  test("exports verify and chat", async () => {
    const runner = await import("./runner");
    expect(typeof runner.verify).toBe("function");
    expect(typeof runner.chat).toBe("function");
  });

  test("exports are async functions", async () => {
    const runner = await import("./runner");
    expect(runner.verify.constructor.name).toBe("AsyncFunction");
    expect(runner.chat.constructor.name).toBe("AsyncFunction");
  });
});
