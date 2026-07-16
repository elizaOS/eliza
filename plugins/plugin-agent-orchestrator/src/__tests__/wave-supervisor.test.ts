import { describe, expect, it } from "vitest";
import {
  detectWaveCollisions,
  isSalvageEligible,
  readWaveId,
  shouldRefillWave,
} from "../services/wave-supervisor.js";

// W3's lifecycle policy is intentionally tested without a runtime or timers.
describe("wave supervisor pure policy", () => {
  it("reads the canonical wave id and defensive manual-stamp aliases", () => {
    expect(readWaveId({ waveId: "wave-1" })).toBe("wave-1");
    expect(readWaveId({ orchestratorWaveId: "wave-2" })).toBe("wave-2");
    expect(readWaveId({ wave: { id: "wave-3" } })).toBe("wave-3");
    expect(readWaveId({ waveId: "  " })).toBeUndefined();
  });

  it("refills each terminal lane once while the wave goal remains unmet", () => {
    expect(
      shouldRefillWave({
        status: "failed",
        goalMet: false,
        alreadyHandled: false,
      }),
    ).toBe(true);
    expect(
      shouldRefillWave({
        status: "done",
        goalMet: false,
        alreadyHandled: false,
      }),
    ).toBe(true);
    expect(
      shouldRefillWave({
        status: "active",
        goalMet: false,
        alreadyHandled: false,
      }),
    ).toBe(false);
    expect(
      shouldRefillWave({
        status: "failed",
        goalMet: true,
        alreadyHandled: false,
      }),
    ).toBe(false);
    expect(
      shouldRefillWave({
        status: "failed",
        goalMet: false,
        alreadyHandled: true,
      }),
    ).toBe(false);
  });

  it("salvages only failed lanes with a workspace and uncommitted paths", () => {
    expect(
      isSalvageEligible({
        status: "failed",
        workdir: "/tmp/lane",
        changedFiles: ["src/a.ts"],
      }),
    ).toBe(true);
    expect(
      isSalvageEligible({
        status: "done",
        workdir: "/tmp/lane",
        changedFiles: ["src/a.ts"],
      }),
    ).toBe(false);
    expect(
      isSalvageEligible({
        status: "failed",
        workdir: "/tmp/lane",
        changedFiles: [],
      }),
    ).toBe(false);
    expect(
      isSalvageEligible({ status: "failed", changedFiles: ["src/a.ts"] }),
    ).toBe(false);
  });

  it("detects lane-lane directory overlap and lane-PR file overlap", () => {
    expect(
      detectWaveCollisions(
        [
          { laneId: "a", waveId: "w", paths: ["src/auth"], repo: "org/repo" },
          {
            laneId: "b",
            waveId: "w",
            paths: ["src/auth/login.ts"],
            repo: "org/repo",
          },
          {
            laneId: "c",
            waveId: "other",
            paths: ["src/auth"],
            repo: "org/repo",
          },
          {
            laneId: "d",
            waveId: "w",
            paths: ["src/payments"],
            repo: "org/repo",
          },
        ],
        [
          {
            id: "org/repo#7",
            repo: "org/repo",
            number: 7,
            changedFiles: ["src/payments/settle.ts", "README.md"],
          },
        ],
      ),
    ).toEqual([
      {
        key: "lane:a|lane:b",
        waveId: "w",
        leftId: "a",
        rightId: "b",
        paths: ["src/auth"],
        kind: "lane-lane",
      },
      {
        key: "lane:d|pr:org/repo#7",
        waveId: "w",
        leftId: "d",
        rightId: "org/repo#7",
        paths: ["src/payments"],
        kind: "lane-pr",
      },
    ]);
  });

  it("does not compare PR paths without a confirmed matching repository", () => {
    const pullRequest = {
      id: "org/repo#1",
      repo: "org/repo",
      number: 1,
      changedFiles: ["README.md"],
    };
    expect(
      detectWaveCollisions(
        [{ laneId: "unknown", waveId: "w", paths: ["README.md"] }],
        [pullRequest],
      ),
    ).toEqual([]);
    expect(
      detectWaveCollisions(
        [
          {
            laneId: "other",
            waveId: "w",
            paths: ["README.md"],
            repo: "another/project",
          },
        ],
        [pullRequest],
      ),
    ).toEqual([]);
  });

  it("normalizes separators and does not mistake filename prefixes for overlap", () => {
    const collisions = detectWaveCollisions(
      [
        {
          laneId: "a",
          waveId: "w",
          paths: [".\\src\\foo"],
          repo: "org/repo",
        },
        {
          laneId: "b",
          waveId: "w",
          paths: ["src/foobar"],
          repo: "org/repo",
        },
      ],
      [
        {
          id: "org/repo#1",
          repo: "org/repo",
          number: 1,
          changedFiles: ["src/foo/bar.ts"],
        },
      ],
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.kind).toBe("lane-pr");
  });
});
