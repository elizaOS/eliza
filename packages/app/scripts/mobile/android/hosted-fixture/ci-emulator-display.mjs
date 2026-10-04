import { HostedFixtureError } from "./errors.mjs";
// Only the newly created, unsecured GitHub-hosted AOSP fixture may be changed.
// This module never clears credentials and never acts on a user's device.
export function requireHostedFixtureEnvironment(env, serial) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    serial !== "emulator-5554"
  )
    throw new HostedFixtureError(
      "Disposable GitHub-hosted emulator-5554 fixture required",
    );
}

export function parseFixtureDisplay(power, policy) {
  const values = (pattern) =>
    [...policy.matchAll(pattern)].map((match) => match[1]);
  const showing = values(/^\s*(?:showing|mIsShowing)=(true|false)\s*$/gm);
  const restricted = values(
    /^\s*(?:inputRestricted|mInputRestricted)=(true|false)\s*$/gm,
  );
  const secure = values(/^\s*secure=(true|false)\s*$/gm);
  const monitorBound =
    /^\s*KeyguardStateMonitor\s*$/m.test(policy) &&
    /^\s*mCurrentUserId=0\s*$/m.test(policy);
  // AOSP delegate reset sentinel before its binder-backed state monitor exists.
  const startupUnbound =
    !/KeyguardStateMonitor|mCurrentUserId=|mIsShowing=|mInputRestricted=/.test(
      policy,
    ) &&
    /^\s*KeyguardServiceDelegate\s*$/m.test(policy) &&
    /^\s*currentUser=-10000\s*$/m.test(policy) &&
    showing.length === 1 &&
    showing[0] === "true" &&
    restricted.length === 1 &&
    restricted[0] === "false" &&
    secure.length === 1 &&
    secure[0] === "true" &&
    /^\s*deviceHasKeyguard=true\s*$/m.test(policy) &&
    /^\s*enabled=true\s*$/m.test(policy) &&
    /^\s*systemIsReady=true\s*$/m.test(policy) &&
    /^\s*bootCompleted=true\s*$/m.test(policy);
  const ready =
    monitorBound &&
    /^\s*systemIsReady=true\s*$/m.test(policy) &&
    /^\s*bootCompleted=true\s*$/m.test(policy);
  return {
    ready,
    monitorBound,
    startupUnbound,
    malformed:
      !startupUnbound &&
      (!monitorBound ||
        secure.length !== 1 ||
        showing.length !== 2 ||
        restricted.length !== 2),
    secure: secure.length === 1 ? secure[0] === "true" : null,
    awake: /^\s*mWakefulness=Awake\s*$/m.test(power),
    displayOn: /^\s*screenState=SCREEN_STATE_ON\s*$/m.test(policy),
    unlocked:
      showing.length >= 2 && showing.every((value) => value === "false"),
    unrestricted:
      restricted.length >= 2 && restricted.every((value) => value === "false"),
  };
}

export function assertFixtureIdentity(run, { fresh = false } = {}) {
  if (
    run("emu", "avd", "name").trim().split(/\r?\n/)[0] !== "test" ||
    run("shell", "getprop", "ro.kernel.qemu").trim() !== "1" ||
    !["userdebug", "eng"].includes(
      run("shell", "getprop", "ro.build.type").trim(),
    ) ||
    run("shell", "am", "get-current-user").trim() !== "0"
  )
    throw new HostedFixtureError(
      "Wrong disposable AOSP fixture identity or user",
    );
  const users = [
    ...run("shell", "pm", "list", "users").matchAll(/UserInfo\{(\d+):/g),
  ].map((match) => match[1]);
  if (users.length !== 1 || users[0] !== "0")
    throw new HostedFixtureError("Single user0 fixture required");
  if (fresh && run("shell", "pm", "list", "packages", "-3").trim())
    throw new HostedFixtureError(
      "Fresh fixture must not contain third-party applications",
    );
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function prepareFixtureDisplay(
  run,
  {
    env = process.env,
    serial,
    sleep = delay,
    record = () => {},
    budget = { remaining: 30 },
  } = {},
) {
  requireHostedFixtureEnvironment(env, serial);
  assertFixtureIdentity(run, { fresh: true });
  let state;
  for (let attempt = 0; attempt < 30 && budget.remaining-- > 0; attempt++) {
    assertFixtureIdentity(run, { fresh: true });
    state = parseFixtureDisplay(
      run("shell", "dumpsys", "power"),
      run("shell", "dumpsys", "window", "policy"),
    );
    record({ phase: "system-ready", attempt, ...state });
    if (state.malformed)
      throw new HostedFixtureError("Malformed keyguard readiness observation");
    // A bound monitor can briefly retain its conservative secure default.
    // Wait read-only; only observed secure=false can authorize setup below.
    if (state.ready && state.secure === false) break;
    await sleep(500);
  }
  if (!state.ready || state.secure !== false)
    throw new HostedFixtureError("Unsecured keyguard service not ready");
  assertFixtureIdentity(run, { fresh: true });
  // Recheck the credential boundary immediately before the sole lock policy write.
  const secureNow = parseFixtureDisplay(
    run("shell", "dumpsys", "power"),
    run("shell", "dumpsys", "window", "policy"),
  );
  if (secureNow.malformed || !secureNow.ready || secureNow.secure !== false)
    throw new HostedFixtureError("Unsecured fixture admission changed");
  const priorDisabled = run(
    "shell",
    "locksettings",
    "get-disabled",
    "--user",
    "0",
  ).trim();
  if (!["true", "false"].includes(priorDisabled))
    throw new HostedFixtureError("Unknown fixture lockscreen policy");
  run("shell", "locksettings", "set-disabled", "--user", "0", "true");
  assertFixtureIdentity(run, { fresh: true });
  const installedDisabled = run(
    "shell",
    "locksettings",
    "get-disabled",
    "--user",
    "0",
  ).trim();
  record({
    phase: "lockscreen-policy",
    user: "0",
    priorDisabled,
    installedDisabled,
  });
  if (installedDisabled !== "true")
    throw new HostedFixtureError("Fixture lockscreen policy not confirmed");
  run("shell", "svc", "power", "stayon", "true");
  run("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  run("shell", "wm", "dismiss-keyguard");
  run("shell", "input", "keyevent", "KEYCODE_HOME");
  return await requireFixtureDisplay(run, {
    env,
    serial,
    sleep,
    record,
    budget,
  });
}

// Read-only admission, also used immediately before each CI instrumentation run.
export async function requireFixtureDisplay(
  run,
  {
    env = process.env,
    serial,
    sleep = delay,
    record = () => {},
    budget = { remaining: 30 },
  } = {},
) {
  requireHostedFixtureEnvironment(env, serial);
  assertFixtureIdentity(run);
  let consecutive = 0;
  for (let attempt = 0; attempt < 30 && budget.remaining-- > 0; attempt++) {
    if (run("shell", "am", "get-current-user").trim() !== "0")
      throw new HostedFixtureError("Fixture foreground user changed");
    const state = parseFixtureDisplay(
      run("shell", "dumpsys", "power"),
      run("shell", "dumpsys", "window", "policy"),
    );
    record({ phase: "display-admission", attempt, ...state });
    if (state.malformed)
      throw new HostedFixtureError("Malformed keyguard readiness observation");
    // Secure observations never admit instrumentation; they consume the same
    // bounded read-only budget while the binder-backed state settles.
    consecutive =
      state.ready &&
      state.secure === false &&
      state.awake &&
      state.displayOn &&
      state.unlocked &&
      state.unrestricted
        ? consecutive + 1
        : 0;
    if (consecutive === 2) return state;
    await sleep(500);
  }
  throw new HostedFixtureError(
    "CI display is not observed awake, on, unlocked and unrestricted",
  );
}
