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
});
