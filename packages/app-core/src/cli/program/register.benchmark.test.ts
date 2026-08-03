/** Verifies the app CLI exposes benchmark ownership without a response deadline. */
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerBenchmarkCommand } from "./register.benchmark";

describe("registerBenchmarkCommand", () => {
  it("exposes only task input and persistent server mode", () => {
    const program = new Command();
    registerBenchmarkCommand(program);

    const benchmark = program.commands.find(
      (command) => command.name() === "benchmark",
    );
    expect(benchmark).toBeDefined();
    expect(benchmark?.options.map((option) => option.long)).toEqual([
      "--task",
      "--server",
    ]);
  });
});
