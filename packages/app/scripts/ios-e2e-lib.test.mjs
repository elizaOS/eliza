/**
 * Unit tests for the pure decision logic behind the one-command iOS Simulator
 * e2e orchestrator (`ios-e2e.mjs`, wired as `test:e2e:ios`). Deterministic, no
 * simulator required: they pin the flag→step-plan mapping, the loud/vacuous
 * guards, booted-udid selection over `simctl` JSON, app-id extraction, and the
 * exact argv each real leg is spawned with. Runs in the packages/app vitest
 * suite (`bun run --cwd packages/app test`), i.e. the root test:client lane.
 */
import { describe, expect, it } from "bun:test";
import {
  applyIosSimulatorSchemeApproval,
  assertNonVacuousPlan,
  buildAuthSmokeCommand,
  buildCloudProvisioningCommand,
  buildIosSimBuildCommand,
  buildLocalChatSmokeCommand,
  classifyIosSimulatorSchemeDispatch,
  classifyStepExit,
  DEFAULT_IOS_SIMULATOR,
  extractAppId,
  extractAppIdentity,
  IOS_E2E_STEP_IDS,
  IOS_E2E_VERIFICATION_STEP_IDS,
  iosSimulatorSchemeApproval,
  isAppInstalled,
  parseAuthSmokeResult,
  parseIosE2eArgs,
  planIosE2eSteps,
  resolveTargetDevice,
  selectBootedUdid,
} from "./ios-e2e-lib.mjs";

const UDID = "A1B2C3D4-1111-2222-3333-444455556666";

describe("parseIosE2eArgs", () => {
  it("defaults to a full run with no flags", () => {
    const f = parseIosE2eArgs(["node", "ios-e2e.mjs"]);
    expect(f).toEqual({
      device: undefined,
      appPath: undefined,
      output: undefined,
      artifactSources: [],
      skipBuild: false,
      skipAuth: false,
      skipLocalChat: false,
      cloud: false,
      noWait: false,
    });
  });

  it("parses every boolean flag", () => {
    const f = parseIosE2eArgs([
      "--skip-build",
      "--skip-auth",
      "--skip-local-chat",
      "--cloud",
      "--no-wait",
    ]);
    expect(f.skipBuild).toBe(true);
    expect(f.skipAuth).toBe(true);
    expect(f.skipLocalChat).toBe(true);
    expect(f.cloud).toBe(true);
    expect(f.noWait).toBe(true);
  });

  it("captures output, app, device, and repeatable artifact-source values", () => {
    const f = parseIosE2eArgs([
      "--device",
      "iPhone 15",
      "--app-path",
      "/tmp/App.app",
      "--output",
      "/tmp/evidence",
      "--artifact-source",
      "/tmp/recording.mp4",
      "--artifact-source",
      "/tmp/external-logs",
    ]);
    expect(f.device).toBe("iPhone 15");
    expect(f.appPath).toBe("/tmp/App.app");
    expect(f.output).toBe("/tmp/evidence");
    expect(f.artifactSources).toEqual([
      "/tmp/recording.mp4",
      "/tmp/external-logs",
    ]);
  });

  it("does not read past the end of argv for a trailing value flag", () => {
    const f = parseIosE2eArgs(["--device"]);
    expect(f.device).toBeUndefined();
  });

  it("does not consume another flag as an artifact source value", () => {
    const f = parseIosE2eArgs(["--artifact-source", "--skip-build"]);
    expect(f.artifactSources).toEqual([]);
    expect(f.skipBuild).toBe(true);
  });
});

describe("planIosE2eSteps", () => {
  const full = {
    skipBuild: false,
    skipAuth: false,
    skipLocalChat: false,
    cloud: false,
    noWait: false,
  };

  it("runs build → install → auth → local-chat by default (no cloud)", () => {
    const ids = planIosE2eSteps(full).map((s) => s.id);
    expect(ids).toEqual(["build", "install", "auth", "local-chat"]);
  });

  it("appends cloud last only when requested", () => {
    const ids = planIosE2eSteps({ ...full, cloud: true }).map((s) => s.id);
    expect(ids).toEqual(["build", "install", "auth", "local-chat", "cloud"]);
  });

  it("preserves the fixed run order under any flag subset", () => {
    const ids = planIosE2eSteps({ ...full, cloud: true }).map((s) => s.id);
    const canonicalRank = (id) => IOS_E2E_STEP_IDS.indexOf(id);
    const ranks = ids.map(canonicalRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it.each([
    ["skipBuild", "build"],
    ["skipAuth", "auth"],
    ["skipLocalChat", "local-chat"],
  ])("%s removes exactly the %s step", (flag, removedId) => {
    const ids = planIosE2eSteps({ ...full, [flag]: true }).map((s) => s.id);
    expect(ids).not.toContain(removedId);
    // Everything else that would have run still runs.
    for (const id of ["build", "install", "auth", "local-chat"]) {
      if (id !== removedId) expect(ids).toContain(id);
    }
  });

  it("keeps install explicit when --skip-build reuses a supplied app", () => {
    const ids = planIosE2eSteps({ ...full, skipBuild: true }).map(
      (step) => step.id,
    );
    expect(ids).toEqual(["install", "auth", "local-chat"]);
  });

  it("marks only auth/local-chat as simulator-app verification legs", () => {
    const steps = planIosE2eSteps({ ...full, cloud: true });
    const verifying = steps.filter((s) => s.verification).map((s) => s.id);
    expect(verifying).toEqual(IOS_E2E_VERIFICATION_STEP_IDS);
    expect(steps.find((s) => s.id === "build").verification).toBe(false);
    expect(steps.find((s) => s.id === "install").verification).toBe(false);
    expect(steps.find((s) => s.id === "cloud").verification).toBe(false);
  });
});

describe("assertNonVacuousPlan", () => {
  it("returns the verification legs for a real plan", () => {
    const steps = planIosE2eSteps({
      skipBuild: false,
      skipAuth: false,
      skipLocalChat: false,
      cloud: false,
    });
    const verifying = assertNonVacuousPlan(steps);
    expect(verifying.map((s) => s.id)).toEqual(["auth", "local-chat"]);
  });

  it("throws when every verification leg is skipped (build-only is not proof)", () => {
    const steps = planIosE2eSteps({
      skipBuild: false,
      skipAuth: true,
      skipLocalChat: true,
      cloud: false,
    });
    expect(steps.map((s) => s.id)).toEqual(["build", "install"]);
    expect(() => assertNonVacuousPlan(steps)).toThrow(/refusing to run/i);
  });

  it("throws on a fully empty plan", () => {
    expect(() => assertNonVacuousPlan([])).toThrow(/refusing to run/i);
  });

  it("throws when only the cloud leg survives (cloud is optional, not app proof)", () => {
    const steps = planIosE2eSteps({
      skipBuild: true,
      skipAuth: true,
      skipLocalChat: true,
      cloud: true,
    });
    expect(steps.map((s) => s.id)).toEqual(["install", "cloud"]);
    expect(() => assertNonVacuousPlan(steps)).toThrow(
      /cloud alone is not enough/i,
    );
  });

  it("throws when build and cloud survive without auth or local chat", () => {
    const steps = planIosE2eSteps({
      skipBuild: false,
      skipAuth: true,
      skipLocalChat: true,
      cloud: true,
    });
    expect(steps.map((s) => s.id)).toEqual(["build", "install", "cloud"]);
    expect(() => assertNonVacuousPlan(steps)).toThrow(/auth \/ local-chat/i);
  });
});

describe("selectBootedUdid", () => {
  it("returns the udid of the first Booted device", () => {
    const json = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
          { udid: "shutdown-one", state: "Shutdown" },
          { udid: UDID, state: "Booted" },
        ],
      },
    };
    expect(selectBootedUdid(json)).toBe(UDID);
  });

  it("returns null when nothing is booted", () => {
    const json = {
      devices: {
        rt: [{ udid: "x", state: "Shutdown" }],
      },
    };
    expect(selectBootedUdid(json)).toBeNull();
  });

  it.each([
    [null],
    [undefined],
    [{}],
    [{ devices: null }],
    [{ devices: { rt: "nope" } }],
  ])("tolerates malformed simctl json %#", (json) => {
    expect(selectBootedUdid(json)).toBeNull();
  });
});

describe("resolveTargetDevice", () => {
  it("passes through an explicit device", () => {
    expect(resolveTargetDevice("iPhone 15 Pro")).toBe("iPhone 15 Pro");
  });
  it("defaults to the pinned dev simulator", () => {
    expect(resolveTargetDevice(undefined)).toBe(DEFAULT_IOS_SIMULATOR);
  });
});

describe("extractAppId", () => {
  it("reads the appId from app.config.ts source (double quotes)", () => {
    expect(extractAppId('export default { appId: "ai.elizaos.app" }')).toBe(
      "ai.elizaos.app",
    );
  });
  it("reads single-quoted appId", () => {
    expect(extractAppId("{ appId: 'com.example.custom' }")).toBe(
      "com.example.custom",
    );
  });
  it("falls back to the known default when absent", () => {
    expect(extractAppId("export default {}")).toBe("ai.elizaos.app");
  });
});

describe("iOS app identity and custom-scheme approval", () => {
  it("extracts the configured scheme independently from the bundle id", () => {
    expect(
      extractAppIdentity(
        'export default { appId: "ai.elizaos.app", urlScheme: "elizaos" }',
      ),
    ).toEqual({ appId: "ai.elizaos.app", urlScheme: "elizaos" });
  });

  it("uses the bundle id when a config omits urlScheme", () => {
    expect(
      extractAppIdentity('export default { appId: "dev.example" }'),
    ).toEqual({ appId: "dev.example", urlScheme: "dev.example" });
  });

  it("pins the CoreSimulatorBridge LaunchServices approval record", () => {
    expect(
      iosSimulatorSchemeApproval({
        homeDir: "/Users/runner",
        udid: UDID,
        urlScheme: "elizaos",
        appId: "ai.elizaos.app",
      }),
    ).toEqual({
      plistPath: `/Users/runner/Library/Developer/CoreSimulator/Devices/${UDID}/data/Library/Preferences/com.apple.launchservices.schemeapproval.plist`,
      key: "com.apple.CoreSimulator.CoreSimulatorBridge-->elizaos",
      appId: "ai.elizaos.app",
    });
  });

  it("rejects an incomplete approval identity", () => {
    expect(() =>
      iosSimulatorSchemeApproval({
        homeDir: "/Users/runner",
        udid: "",
        urlScheme: "elizaos",
        appId: "ai.elizaos.app",
      }),
    ).toThrow(/requires homeDir, udid, urlScheme, and appId/);
  });

  it("keeps an unapproved callback blocked and lets the approved path reach the app", () => {
    const approval = iosSimulatorSchemeApproval({
      homeDir: "/Users/runner",
      udid: UDID,
      urlScheme: "elizaos",
      appId: "ai.elizaos.app",
    });
    const unrelatedApproval = {
      "com.apple.CoreSimulator.CoreSimulatorBridge-->other": "dev.other",
    };

    expect(
      classifyIosSimulatorSchemeDispatch(unrelatedApproval, approval),
    ).toBe("confirmation-blocked");

    const mutation = applyIosSimulatorSchemeApproval(
      unrelatedApproval,
      approval,
    );
    expect(mutation).toEqual({
      entries: {
        ...unrelatedApproval,
        "com.apple.CoreSimulator.CoreSimulatorBridge-->elizaos":
          "ai.elizaos.app",
      },
      previousAppId: null,
      changed: true,
    });
    expect(classifyIosSimulatorSchemeDispatch(mutation.entries, approval)).toBe(
      "deliver-to-app",
    );
  });

  it("repairs a scheme mapped to the wrong bundle and is idempotent once approved", () => {
    const approval = iosSimulatorSchemeApproval({
      homeDir: "/Users/runner",
      udid: UDID,
      urlScheme: "elizaos",
      appId: "ai.elizaos.app",
    });
    const wrong = { [approval.key]: "dev.impostor" };
    const repaired = applyIosSimulatorSchemeApproval(wrong, approval);
    expect(repaired.previousAppId).toBe("dev.impostor");
    expect(repaired.changed).toBe(true);
    expect(classifyIosSimulatorSchemeDispatch(repaired.entries, approval)).toBe(
      "deliver-to-app",
    );

    const unchanged = applyIosSimulatorSchemeApproval(
      repaired.entries,
      approval,
    );
    expect(unchanged.changed).toBe(false);
    expect(unchanged.entries).toBe(repaired.entries);
  });

  it("rejects a malformed approval dictionary", () => {
    const approval = iosSimulatorSchemeApproval({
      homeDir: "/Users/runner",
      udid: UDID,
      urlScheme: "elizaos",
      appId: "ai.elizaos.app",
    });
    expect(() => applyIosSimulatorSchemeApproval([], approval)).toThrow(
      /must be an object/,
    );
  });
});

describe("leg command builders", () => {
  it("builds the sim build command", () => {
    expect(buildIosSimBuildCommand()).toEqual({
      cmd: "bun",
      args: ["run", "build:ios:local:sim"],
    });
  });

  it("targets the booted udid for the auth leg", () => {
    expect(buildAuthSmokeCommand(UDID)).toEqual({
      cmd: "node",
      args: [
        "../../packages/app-core/scripts/mobile-auth-simulator-smoke.mjs",
        "--platform",
        "ios",
        "--device",
        UDID,
      ],
    });
  });

  it("refuses to build an auth command without a udid", () => {
    expect(() => buildAuthSmokeCommand(undefined)).toThrow(/udid/i);
  });

  it("keeps the flags that make the chat leg real (no host fallback, full-bun engine)", () => {
    const { args } = buildLocalChatSmokeCommand();
    expect(args).toContain("--require-installed");
    expect(args).toContain("--ios-select-local");
    expect(args).toContain("--ios-full-bun-smoke");
    expect(args.slice(0, 3)).toEqual([
      "scripts/mobile-local-chat-smoke.mjs",
      "--platform",
      "ios",
    ]);
  });

  it("builds the cloud provisioning command", () => {
    expect(buildCloudProvisioningCommand()).toEqual({
      cmd: "node",
      args: ["scripts/cloud-provisioning-e2e.mjs"],
    });
  });
});

describe("parseAuthSmokeResult", () => {
  it("extracts the final JSON receipt after human-readable logs", () => {
    expect(
      parseAuthSmokeResult(
        '[mobile-auth-smoke] opening callback\n{\n  "lane": "callback",\n  "simulators": [{"platform":"ios"}]\n}\n',
      ),
    ).toEqual({
      lane: "callback",
      simulators: [{ platform: "ios" }],
    });
  });

  it("rejects output without a complete trailing object", () => {
    expect(() =>
      parseAuthSmokeResult("[mobile-auth-smoke] no receipt"),
    ).toThrow(/did not end with a JSON object/);
  });
});

describe("classifyStepExit", () => {
  it("treats exit 0 as ok", () => {
    expect(classifyStepExit(0)).toEqual({ ok: true });
  });
  it("treats a non-zero exit as a hard failure", () => {
    expect(classifyStepExit(1)).toEqual({
      ok: false,
      reason: "exited with code 1",
    });
  });
  it("treats a signal kill (null status) as a hard failure", () => {
    expect(classifyStepExit(null)).toEqual({
      ok: false,
      reason: "terminated by signal",
    });
  });
});

describe("isAppInstalled", () => {
  it("accepts a non-empty container path", () => {
    expect(isAppInstalled("/Users/x/App.app")).toBe(true);
  });
  it.each([
    ["", false],
    ["   ", false],
    [null, false],
    [undefined, false],
  ])("rejects %p", (container, expected) => {
    expect(isAppInstalled(container)).toBe(expected);
  });
});
