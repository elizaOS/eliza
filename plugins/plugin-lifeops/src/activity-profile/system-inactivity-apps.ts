export interface ActivityAppIdentity {
  bundleId?: string | null;
  appName?: string | null;
  executableName?: string | null;
  platform?: string | null;
}

const MACOS_INACTIVITY_BUNDLE_IDS = new Set([
  "com.apple.loginwindow",
  "com.apple.screensaver.engine",
  "com.apple.securityagent",
]);

const MACOS_INACTIVITY_NAMES = new Set([
  "loginwindow",
  "login window",
  "screensaverengine",
  "screen saver engine",
  "securityagent",
  "security agent",
]);

const WINDOWS_INACTIVITY_NAMES = new Set([
  "lockapp",
  "logonui",
  "winlogon",
  "credentialuibroker",
  "credential ui broker",
  "windows lock application",
  "windows logon application",
]);

const WINDOWS_INACTIVITY_IDS = new Set([
  "microsoft.lockapp",
  "microsoft.windows.lockapp",
]);

const LINUX_INACTIVITY_NAMES = new Set([
  "cinnamon-screensaver",
  "gdm",
  "gdm3",
  "gnome-screensaver",
  "i3lock",
  "kscreenlocker",
  "kscreenlocker_greet",
  "light-locker",
  "lightdm-gtk-greeter",
  "mate-screensaver",
  "sddm-greeter",
  "slock",
  "unity-greeter",
  "xfce4-screensaver",
  "xlock",
  "xscreensaver",
]);

const LINUX_INACTIVITY_IDS = new Set([
  "org.freedesktop.screensaver",
  "org.gnome.screensaver",
]);

function normalizedValues(identity: ActivityAppIdentity): {
  ids: string[];
  names: string[];
} {
  const ids = [identity.bundleId]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const rawNames = [identity.appName, identity.executableName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const names = rawNames.flatMap((value) => {
    const withoutExe = value.endsWith(".exe") ? value.slice(0, -4) : value;
    return withoutExe === value ? [value] : [value, withoutExe];
  });
  return { ids, names };
}

function anyIn(values: string[], set: Set<string>): boolean {
  return values.some((value) => set.has(value));
}

export function isSystemInactivityApp(identity: ActivityAppIdentity): boolean {
  const { ids, names } = normalizedValues(identity);
  return (
    anyIn(ids, MACOS_INACTIVITY_BUNDLE_IDS) ||
    anyIn(ids, WINDOWS_INACTIVITY_IDS) ||
    anyIn(ids, LINUX_INACTIVITY_IDS) ||
    anyIn(names, MACOS_INACTIVITY_NAMES) ||
    anyIn(names, WINDOWS_INACTIVITY_NAMES) ||
    anyIn(names, LINUX_INACTIVITY_NAMES)
  );
}
