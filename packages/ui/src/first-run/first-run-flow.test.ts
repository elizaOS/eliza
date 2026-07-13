import { describe, expect, it } from "vitest";
import { FIRST_RUN_ACTION_PREFIX } from "./first-run-action-channel";
import {
  FIRST_RUN_ALLOWED_ACTION_GROUPS,
  type FirstRunActionGroup,
  type FirstRunFlowPhase,
  firstRunFlowPhase,
  isFirstRunFlowBusy,
  isFirstRunFlowProvisioned,
  isFirstRunFlowSilent,
  parseFirstRunAction,
  revealFirstRunFlow,
  routeFirstRunAction,
} from "./first-run-flow";

const action = (group: FirstRunActionGroup, id: string): string =>
  `${FIRST_RUN_ACTION_PREFIX}${group}:${id}`;

const phases: FirstRunFlowPhase[] = [
  firstRunFlowPhase.choosingRuntime(),
  firstRunFlowPhase.choosingProvider(),
  firstRunFlowPhase.connectingRemote(),
  firstRunFlowPhase.restoringBackup(),
  firstRunFlowPhase.signingIn(),
  firstRunFlowPhase.handoff(),
  firstRunFlowPhase.provisioning(),
  firstRunFlowPhase.choosingCloudAgent(),
  firstRunFlowPhase.wrapUp(),
  firstRunFlowPhase.error("failed"),
  firstRunFlowPhase.complete(),
];

const sampleActionByGroup: Record<FirstRunActionGroup, string> = {
  runtime: action("runtime", "local"),
  provider: action("provider", "on-device"),
  "backup-restore": action("backup-restore", "latest"),
  "cloud-agent": action("cloud-agent", "agent-1"),
  back: action("back", "runtime"),
  error: action("error", "retry"),
  accent: action("accent", "violet"),
  tutorial: action("tutorial", "skip"),
};

describe("first-run flow phases", () => {
  it("constructs every phase with only its required state", () => {
    expect(phases).toEqual([
      { kind: "choosing-runtime" },
      { kind: "choosing-provider" },
      { kind: "connecting-remote" },
      { kind: "restoring-backup" },
      { kind: "signing-in" },
      { kind: "handoff" },
      { kind: "provisioning", visibility: "visible" },
      { kind: "choosing-cloud-agent" },
      { kind: "wrap-up" },
      { kind: "error", message: "failed" },
      { kind: "complete" },
    ]);
  });

  it("derives busy and provisioned state from the phase", () => {
    expect(
      phases.filter(isFirstRunFlowBusy).map((phase) => phase.kind),
    ).toEqual(["restoring-backup", "handoff", "provisioning"]);
    expect(
      phases.filter(isFirstRunFlowProvisioned).map((phase) => phase.kind),
    ).toEqual(["wrap-up", "complete"]);
  });

  it("reveals only silent provisioning", () => {
    const silent = firstRunFlowPhase.provisioning("silent");
    expect(isFirstRunFlowSilent(silent)).toBe(true);
    expect(revealFirstRunFlow(silent)).toEqual({
      kind: "provisioning",
      visibility: "visible",
    });

    const error = firstRunFlowPhase.error("no connection");
    expect(isFirstRunFlowSilent(error)).toBe(false);
    expect(revealFirstRunFlow(error)).toBe(error);
  });
});

describe("parseFirstRunAction", () => {
  it("parses and canonicalizes a reserved action", () => {
    expect(
      parseFirstRunAction(
        `${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Sign in to Eliza Cloud`,
      ),
    ).toEqual({
      group: "runtime",
      id: "cloud",
      value: `${FIRST_RUN_ACTION_PREFIX}runtime:cloud`,
    });
  });

  it.each([
    "hello",
    FIRST_RUN_ACTION_PREFIX,
    `${FIRST_RUN_ACTION_PREFIX}runtime`,
    `${FIRST_RUN_ACTION_PREFIX}runtime:`,
    `${FIRST_RUN_ACTION_PREFIX}unknown:value`,
  ])("returns null for non-reserved or malformed input: %s", (value) => {
    expect(parseFirstRunAction(value)).toBeNull();
  });
});

describe("routeFirstRunAction", () => {
  it("passes ordinary chat through and consumes malformed reserved values", () => {
    expect(
      routeFirstRunAction(firstRunFlowPhase.choosingRuntime(), "hello"),
    ).toEqual({ kind: "pass-through" });
    expect(
      routeFirstRunAction(
        firstRunFlowPhase.choosingRuntime(),
        `${FIRST_RUN_ACTION_PREFIX}unknown:value`,
      ),
    ).toEqual({ kind: "consume", reason: "malformed" });
  });

  it("uses the phase table as the dispatch boundary", () => {
    for (const phase of phases) {
      const allowed = new Set(FIRST_RUN_ALLOWED_ACTION_GROUPS[phase.kind]);
      for (const [group, value] of Object.entries(sampleActionByGroup) as Array<
        [FirstRunActionGroup, string]
      >) {
        expect(routeFirstRunAction(phase, value).kind).toBe(
          allowed.has(group) ? "dispatch" : "consume",
        );
      }
    }
  });

  it("returns the parsed action when dispatching", () => {
    expect(
      routeFirstRunAction(
        firstRunFlowPhase.choosingCloudAgent(),
        action("cloud-agent", "agent-42"),
      ),
    ).toEqual({
      kind: "dispatch",
      action: {
        group: "cloud-agent",
        id: "agent-42",
        value: action("cloud-agent", "agent-42"),
      },
    });
  });

  it("allows only the cloud runtime in cloud-only mode", () => {
    const phase = firstRunFlowPhase.signingIn();
    expect(
      routeFirstRunAction(phase, action("runtime", "cloud"), {
        mode: "cloud-only",
      }).kind,
    ).toBe("dispatch");

    for (const runtime of ["local", "remote"]) {
      expect(
        routeFirstRunAction(phase, action("runtime", runtime), {
          mode: "cloud-only",
        }),
      ).toMatchObject({ kind: "consume", reason: "cloud-only" });
    }
  });

  it("does not turn error:restart into retry in cloud-only mode", () => {
    const phase = firstRunFlowPhase.error("failed");
    expect(
      routeFirstRunAction(phase, action("error", "restart"), {
        mode: "cloud-only",
      }),
    ).toMatchObject({ kind: "consume", reason: "cloud-only" });
    expect(
      routeFirstRunAction(phase, action("error", "retry"), {
        mode: "cloud-only",
      }).kind,
    ).toBe("dispatch");
    expect(
      routeFirstRunAction(phase, action("error", "settings"), {
        mode: "cloud-only",
      }).kind,
    ).toBe("dispatch");
    expect(
      routeFirstRunAction(phase, action("error", "restart"), {
        mode: "runtime-chooser",
      }).kind,
    ).toBe("dispatch");
  });

  it("keeps chooser-only actions inert in cloud-only mode", () => {
    expect(
      routeFirstRunAction(
        firstRunFlowPhase.choosingCloudAgent(),
        action("back", "runtime"),
        { mode: "cloud-only" },
      ),
    ).toMatchObject({ kind: "consume", reason: "cloud-only" });

    for (const value of [
      action("provider", "on-device"),
      action("backup-restore", "latest"),
    ]) {
      expect(
        routeFirstRunAction(firstRunFlowPhase.choosingRuntime(), value, {
          mode: "cloud-only",
        }),
      ).not.toMatchObject({ kind: "dispatch" });
    }
  });

  it("lets a runtime choice escape a hung backup restore without allowing a duplicate restore", () => {
    const phase = firstRunFlowPhase.restoringBackup();
    expect(routeFirstRunAction(phase, action("runtime", "cloud")).kind).toBe(
      "dispatch",
    );
    expect(
      routeFirstRunAction(phase, action("backup-restore", "latest")),
    ).toMatchObject({ kind: "consume", reason: "phase" });
  });

  it("keeps every reserved action inert after completion", () => {
    for (const value of Object.values(sampleActionByGroup)) {
      expect(
        routeFirstRunAction(firstRunFlowPhase.complete(), value),
      ).toMatchObject({ kind: "consume", reason: "phase" });
    }
  });
});
