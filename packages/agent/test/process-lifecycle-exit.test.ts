/** Real process signals, disk teardown receipts and supervisor exit status. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

function runShutdown(
  executable: string,
  failure: string,
  firstSignal = "SIGTERM",
  repeat = "",
) {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-shutdown-"));
  try {
    const receipt = path.join(dir, "receipt");
    const child = spawnSync(
      executable,
      [
        path.join(import.meta.dirname, "fixtures/process-lifecycle-child.ts"),
        receipt,
        failure,
        firstSignal,
        repeat,
      ],
      { timeout: 10_000, killSignal: "SIGKILL", encoding: "utf8" },
    );
    expect(child.error).toBeUndefined();
    return { child, steps: readFileSync(receipt, "utf8").trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each(["", "teardown", "reporter"])(
  "drains cleanup and reports shutdown status (%s)",
  (failure) => {
    const { child, steps } = runShutdown("bun", failure);
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(failure ? 1 : 0);
    expect(steps).toEqual([
      "last",
      "first",
      "sandbox",
      "runtime",
      ...(failure ? ["reported"] : []),
    ]);
  },
);

for (const [host, executable] of [
  ["Bun", "bun"],
  ["Node", process.execPath],
]) {
  it.each([
    ["SIGTERM", "SIGTERM", ""],
    ["SIGINT", "SIGINT", "reporter"],
    ["SIGTERM", "SIGINT", ""],
  ])(
    `drains ${host} cleanup after %s then %s (%s)`,
    (firstSignal, repeat, failure) => {
      const { child, steps } = runShutdown(
        executable,
        failure,
        firstSignal,
        repeat,
      );
      expect(child.signal, `Cleanup receipt: ${steps.join(", ")}`).toBeNull();
      expect(child.status, child.stderr).toBe(failure ? 1 : 0);
      expect(steps).toEqual([
        "last",
        `delivered ${repeat}`,
        "first",
        "sandbox",
        "runtime",
        ...(failure ? ["reported"] : []),
      ]);
    },
  );

  it(`distinguishes ${host} SIGKILL from completed cleanup`, () => {
    const { child, steps } = runShutdown(executable, "", "SIGTERM", "SIGKILL");
    expect(child.signal).toBe("SIGKILL");
    expect(child.status).toBeNull();
    expect(steps).toEqual(["last"]);
  });
}
