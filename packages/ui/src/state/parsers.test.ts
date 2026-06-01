import { describe, expect, it } from "vitest";
import {
  buildLifeOpsGoalCommandMetadata,
  getLifeOpsGoalCommandStyleLabel,
  parseLifeOpsGoalCommandArgs,
} from "./parsers";

describe("parseLifeOpsGoalCommandArgs", () => {
  it("parses a default ongoing goal", () => {
    expect(parseLifeOpsGoalCommandArgs("ship the upstream patches")).toEqual({
      title: "ship the upstream patches",
      goalStyle: "ongoing",
    });
  });

  it("parses style prefixes and quoted titles", () => {
    expect(
      parseLifeOpsGoalCommandArgs('sprint "finish Discord route"'),
    ).toEqual({
      title: "finish Discord route",
      goalStyle: "sprint",
    });
  });

  it("parses explicit style options", () => {
    expect(
      parseLifeOpsGoalCommandArgs("--style=milestone publish one clean PR"),
    ).toEqual({
      title: "publish one clean PR",
      goalStyle: "milestone",
    });

    expect(
      parseLifeOpsGoalCommandArgs("style maintenance keep branches tidy"),
    ).toEqual({
      title: "keep branches tidy",
      goalStyle: "maintenance",
    });
  });

  it("returns null when no title is present", () => {
    expect(parseLifeOpsGoalCommandArgs("sprint")).toBeNull();
  });
});

describe("buildLifeOpsGoalCommandMetadata", () => {
  it("stores command provenance and style hints as metadata", () => {
    expect(getLifeOpsGoalCommandStyleLabel("maintenance")).toBe("Maintenance");
    expect(
      buildLifeOpsGoalCommandMetadata("maintenance", { roomId: "room-1" }),
    ).toMatchObject({
      source: "chat_command",
      command: "/goal",
      lifeopsGoalWorkstream: {
        enabled: true,
        autoSpawnAgent: true,
        framework: "codex",
        label: "GoalScout",
        roomId: "room-1",
      },
      lifeopsGoalStyle: {
        kind: "maintenance",
        label: "Maintenance",
        promptHints: expect.arrayContaining([
          "Treat this as a recurring upkeep objective.",
        ]),
      },
    });
  });
});
