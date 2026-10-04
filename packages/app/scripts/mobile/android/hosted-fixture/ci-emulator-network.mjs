import {
  assertFixtureIdentity,
  requireHostedFixtureEnvironment,
} from "./ci-emulator-display.mjs";
import { HostedFixtureError } from "./errors.mjs";

// Retain only capability booleans, never addresses, SSIDs or network identifiers.
export function parseFixtureNetwork(text) {
  const defaults = [...text.matchAll(/^Active default network: (\S+)\s*$/gm)];
  if (defaults.length !== 1 || !/^(?:none|\d+)$/.test(defaults[0][1]))
    throw new HostedFixtureError("Unknown fixture default network state");
  const id = defaults[0][1];
  if (id === "none")
    return { active: false, internet: false, validated: false };
  const networks = text
    .split(/\r?\n/)
    .filter((line) =>
      line.trimStart().startsWith(`NetworkAgentInfo{network{${id}} `),
    );
  if (networks.length !== 1)
    throw new HostedFixtureError("Unknown fixture active network capabilities");
  const capabilities = /\bnc\{\[.*?\bCapabilities: ([^\]]+)/.exec(networks[0]);
  if (!capabilities)
    throw new HostedFixtureError("Unknown fixture active network capabilities");
  const names = capabilities[1].split(/\s/)[0].split("&");
  return {
    active: true,
    internet: names.includes("INTERNET"),
    validated: names.includes("VALIDATED"),
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Preserve only probe enums/statuses, never URLs, headers, hostnames or addresses.
export function parseNetworkValidationProbes(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const kind = /\bPROBE_(DNS|HTTP|HTTPS|FALLBACK|PRIVDNS)\b/.exec(line)?.[1];
    if (!kind) return [];
    const code = /\bret=(\d{3})\b/.exec(line)?.[1];
    const errorCode =
      /\b(ENONET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED|EACCES|EPERM)\b/.exec(
        line,
      )?.[1] ?? null;
    return [
      {
        kind,
        status: /\bFAIL\b|Probe failed with exception/.test(line)
          ? "failed"
          : /\bOK\b/.test(line) || code
            ? "completed"
            : "unknown",
        httpStatus: code ? Number(code) : null,
        errorCode,
      },
    ];
  });
}
// Failure diagnostics never retain raw Wi-Fi output, addresses or identifiers.
export function fixtureNetworkDiagnostics(run) {
  const read = (...args) => {
    try {
      return run("shell", ...args);
    } catch {
      return null;
    }
  };
  const flag = (name) => {
    const value = read("settings", "get", "global", name)?.trim();
    return value === "1" ? true : value === "0" ? false : null;
  };
  const wifi = read("cmd", "wifi", "status");
  const supplicant = /\bSupplicant state: ([A-Z_]+),/.exec(wifi ?? "")?.[1];
  const states = [
    "DISCONNECTED",
    "INTERFACE_DISABLED",
    "INACTIVE",
    "SCANNING",
    "AUTHENTICATING",
    "ASSOCIATING",
    "ASSOCIATED",
    "FOUR_WAY_HANDSHAKE",
    "GROUP_HANDSHAKE",
    "COMPLETED",
    "DORMANT",
    "UNINITIALIZED",
    "INVALID",
  ];
  return {
    airplaneMode: flag("airplane_mode_on"),
    mobileDataEnabled: flag("mobile_data"),
    wifiStatusAvailable: wifi !== null,
    validationProbes: parseNetworkValidationProbes(
      read("dumpsys", "network_stack") ?? "",
    ),
    wifiEnabled: /^Wifi is enabled\s*$/m.test(wifi ?? "")
      ? true
      : /^Wifi is disabled\s*$/m.test(wifi ?? "")
        ? false
        : null,
    fixtureAccessPointConnected:
      wifi === null
        ? null
        : /^Wifi is connected to "AndroidWifi"\s*$/m.test(wifi),
    supplicantState: states.includes(supplicant) ? supplicant : null,
  };
}
export async function prepareFixtureNetwork(
  run,
  { env = process.env, serial, sleep = delay, record = () => {} } = {},
) {
  const admit = () => {
    requireHostedFixtureEnvironment(env, serial);
    assertFixtureIdentity(run);
    // Provider preparation is the only allowed prior install. Never provision
    // connectivity on a populated emulator, a user's device or a secondary user.
    const packages = run("shell", "pm", "list", "packages", "-3")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (packages.some((value) => value !== "package:com.android.webview"))
      throw new HostedFixtureError("Fresh network fixture required");
  };
  admit();
  const before = parseFixtureNetwork(run("shell", "dumpsys", "connectivity"));
  record({ phase: "before", ...before });
  if (!before.active || !before.internet || !before.validated) {
    // The SDK emulator owns this open virtual AP. Configure it once, before
    // measuring real requests; never retry or replace failed product operations.
    admit();
    record({ phase: "diagnostics-before", ...fixtureNetworkDiagnostics(run) });
    const waitForRadio = async (enabled) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        admit();
        const status = run("shell", "cmd", "wifi", "status");
        const state = /^Wifi is enabled\s*$/m.test(status)
          ? true
          : /^Wifi is disabled\s*$/m.test(status)
            ? false
            : null;
        record({
          phase: "radio",
          requestedEnabled: enabled,
          attempt,
          enabled: state,
        });
        if (state === enabled) return;
        await sleep(250);
      }
      throw new HostedFixtureError(
        "Disposable emulator Wi-Fi radio transition did not complete",
      );
    };
    // After a framework restart, the supplicant can remain connected while
    // ConnectivityService has no network. Recreate that fixture attachment
    // once instead of treating a redundant connect command as recovery.
    admit();
    run("shell", "cmd", "wifi", "set-wifi-enabled", "disabled");
    await waitForRadio(false);
    admit();
    run("shell", "cmd", "wifi", "set-wifi-enabled", "enabled");
    await waitForRadio(true);
    admit();
    run("shell", "cmd", "wifi", "connect-network", "AndroidWifi", "open");
  }
  let consecutive = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    admit();
    const state = parseFixtureNetwork(run("shell", "dumpsys", "connectivity"));
    record({ phase: "admission", attempt, ...state });
    consecutive =
      state.active && state.internet && state.validated ? consecutive + 1 : 0;
    if (consecutive === 2) return state;
    await sleep(500);
  }
  admit();
  record({ phase: "diagnostics-failed", ...fixtureNetworkDiagnostics(run) });
  throw new HostedFixtureError(
    "Disposable emulator has no validated Internet network",
  );
}
