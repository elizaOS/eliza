import { describe, expect, it } from "vitest";
import {
  initialState,
  type OnboardingEvent,
  type OnboardingFlowState,
  reduce,
} from "./state-machine";

function run(events: OnboardingEvent[]): OnboardingFlowState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

describe("onboarding/state-machine", () => {
  it("cloud path starts provisioning immediately and finishes through the tutorial", () => {
    const finalState = run([
      { type: "BEGIN" },
      { type: "CHOOSE_RUNTIME", runtime: "cloud" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
    ]);
    expect(finalState.current).toBe("home");
    expect(finalState.runtime).toBe("cloud");
    expect(finalState.cloudProvisioningStarted).toBe(true);
    expect(finalState.history).toContain("cloud-chat");
    expect(finalState.history).toContain("tutorial-permissions");
  });

  it("local-only path downloads in the background during tutorial, then gates home until ready", () => {
    const blocked = run([
      { type: "BEGIN" },
      { type: "CHOOSE_RUNTIME", runtime: "device" },
      { type: "CONTINUE" },
      { type: "CHOOSE_SANDBOX", mode: "sandbox" },
      { type: "CONTINUE" },
      { type: "CHOOSE_DEVICE_PATH", path: "local-only" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "SET_NAME", name: "Ada" },
      { type: "CONTINUE" },
      { type: "SET_LOCATION", location: "Paris" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
    ]);
    expect(blocked.current).toBe("local-download");
    expect(blocked.localDownloadStarted).toBe(true);
    expect(blocked.localDownloadReady).toBeUndefined();

    const finalState = run([
      { type: "BEGIN" },
      { type: "CHOOSE_RUNTIME", runtime: "device" },
      { type: "CONTINUE" },
      { type: "CHOOSE_SANDBOX", mode: "sandbox" },
      { type: "CONTINUE" },
      { type: "CHOOSE_DEVICE_PATH", path: "local-only" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "SET_NAME", name: "Ada" },
      { type: "CONTINUE" },
      { type: "SET_LOCATION", location: "Paris" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "LOCAL_DOWNLOAD_READY" },
      { type: "CONTINUE" },
    ]);
    expect(finalState.current).toBe("home");
    expect(finalState.devicePath).toBe("local-only");
    expect(finalState.sandboxMode).toBe("sandbox");
    expect(finalState.localDownloadStarted).toBe(true);
    expect(finalState.localDownloadReady).toBe(true);
    expect(finalState.name).toBe("Ada");
    expect(finalState.location).toBe("Paris");
  });

  it("remote path: hello -> setup -> remote-pair -> mic -> ... -> home", () => {
    const finalState = run([
      { type: "BEGIN" },
      { type: "CHOOSE_RUNTIME", runtime: "remote" },
      { type: "CONTINUE" },
      { type: "PAIR_REMOTE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
      { type: "CONTINUE" },
    ]);
    expect(finalState.current).toBe("home");
    expect(finalState.runtime).toBe("remote");
  });

  it("BACK pops the most recent history entry", () => {
    const state = run([
      { type: "BEGIN" },
      { type: "CHOOSE_RUNTIME", runtime: "cloud" },
      { type: "CONTINUE" },
    ]);
    expect(state.current).toBe("cloud-login");
    const back = reduce(state, { type: "BACK" });
    expect(back.current).toBe("setup");
  });

  it("SKIP from mic advances to profile-name", () => {
    const state = run([
      { type: "BEGIN" },
      { type: "CHOOSE_RUNTIME", runtime: "remote" },
      { type: "CONTINUE" },
      { type: "PAIR_REMOTE" },
    ]);
    expect(state.current).toBe("mic");
    const skipped = reduce(state, { type: "SKIP" });
    expect(skipped.current).toBe("profile-name");
  });

  it("SKIP from any tutorial state jumps to home", () => {
    const state = run([{ type: "JUMP", to: "tutorial-views" }]);
    expect(state.current).toBe("tutorial-views");
    const skipped = reduce(state, { type: "SKIP" });
    expect(skipped.current).toBe("home");
  });

  it("JUMP appends previous state to history (resume hook)", () => {
    const state = run([{ type: "JUMP", to: "tutorial-views" }]);
    expect(state.current).toBe("tutorial-views");
    expect(state.history).toEqual(["hello"]);
  });

  it("PICK_TUTORIAL goes to subscriptions when chosen", () => {
    const state = run([{ type: "JUMP", to: "tutorial-settings" }]);
    const picked = reduce(state, {
      type: "PICK_TUTORIAL",
      next: "subscriptions",
    });
    expect(picked.current).toBe("tutorial-subscriptions");
  });

  it("SET_LANGUAGE / SET_NAME / SET_LOCATION update fields without moving state", () => {
    const language = reduce(initialState, {
      type: "SET_LANGUAGE",
      language: "es-ES",
    });
    expect(language.language).toBe("es-ES");
    expect(language.current).toBe("hello");

    const name = reduce(language, { type: "SET_NAME", name: "Lin" });
    expect(name.name).toBe("Lin");

    const loc = reduce(name, { type: "SET_LOCATION", location: "Seoul" });
    expect(loc.location).toBe("Seoul");
  });

  it("CONNECT_CLOUD shortcuts straight to cloud-chat", () => {
    const state = reduce(initialState, { type: "CONNECT_CLOUD" });
    expect(state.current).toBe("cloud-chat");
    expect(state.runtime).toBe("cloud");
  });

  it("device-mode local-cloud skips cloud provisioning and local downloads", () => {
    const state = run([
      { type: "JUMP", to: "device-mode" },
      { type: "CHOOSE_DEVICE_PATH", path: "local-cloud" },
      { type: "CONTINUE" },
    ]);
    expect(state.current).toBe("mic");
    expect(state.localDownloadStarted).toBeUndefined();
    expect(state.cloudProvisioningStarted).toBeUndefined();
  });

  it("LOCAL_HARDWARE_ADVICE stores the advice without moving state", () => {
    const advice = {
      memory: "tight" as const,
      disk: "fits" as const,
      recommended: "local-with-warning" as const,
      reasons: [
        "Memory is close to the model requirement; performance may suffer",
      ],
    };
    const state = reduce(initialState, {
      type: "LOCAL_HARDWARE_ADVICE",
      advice,
    });
    expect(state.hardwareAdvice).toEqual(advice);
    expect(state.current).toBe("hello");
  });

  it("CLOUD_FALLBACK_REQUESTED from local-download jumps to cloud-login and flips runtime", () => {
    const before = run([
      { type: "BEGIN" },
      { type: "CHOOSE_RUNTIME", runtime: "device" },
      { type: "CONTINUE" },
      { type: "CHOOSE_SANDBOX", mode: "sandbox" },
      { type: "CONTINUE" },
      { type: "CHOOSE_DEVICE_PATH", path: "local-only" },
      { type: "JUMP", to: "local-download" },
    ]);
    expect(before.current).toBe("local-download");
    const after = reduce(before, { type: "CLOUD_FALLBACK_REQUESTED" });
    expect(after.current).toBe("cloud-login");
    expect(after.runtime).toBe("cloud");
    expect(after.cloudProvisioningStarted).toBe(true);
  });

  it("CLOUD_FALLBACK_REQUESTED from device-security jumps to cloud-login", () => {
    const before = run([
      { type: "BEGIN" },
      { type: "CHOOSE_RUNTIME", runtime: "device" },
      { type: "CONTINUE" },
    ]);
    expect(before.current).toBe("device-security");
    const after = reduce(before, { type: "CLOUD_FALLBACK_REQUESTED" });
    expect(after.current).toBe("cloud-login");
    expect(after.runtime).toBe("cloud");
  });

  it("CLOUD_FALLBACK_REQUESTED is a no-op outside the device-* / local-download branch", () => {
    const before = run([{ type: "JUMP", to: "tutorial-permissions" }]);
    const after = reduce(before, { type: "CLOUD_FALLBACK_REQUESTED" });
    expect(after.current).toBe("tutorial-permissions");
  });

  it("ONBOARDING_END_BLOCKED sets blocker only on tutorial-permissions", () => {
    const onPermissions = run([{ type: "JUMP", to: "tutorial-permissions" }]);
    const blocked = reduce(onPermissions, {
      type: "ONBOARDING_END_BLOCKED",
      reason: "Local model still downloading",
    });
    expect(blocked.current).toBe("tutorial-permissions");
    expect(blocked.blocker).toBe("Local model still downloading");

    const elsewhere = reduce(initialState, {
      type: "ONBOARDING_END_BLOCKED",
      reason: "nope",
    });
    expect(elsewhere.blocker).toBeUndefined();
  });

  it("LOCAL_DOWNLOAD_INTERRUPTED clears the started/ready flags", () => {
    const started = reduce(initialState, { type: "START_LOCAL_DOWNLOAD" });
    const ready = reduce(started, { type: "LOCAL_DOWNLOAD_READY" });
    expect(ready.localDownloadReady).toBe(true);
    const interrupted = reduce(ready, { type: "LOCAL_DOWNLOAD_INTERRUPTED" });
    expect(interrupted.localDownloadReady).toBe(false);
    expect(interrupted.localDownloadStarted).toBe(false);
  });
});
