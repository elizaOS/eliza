/**
 * Pure iOS Info.plist / project.pbxproj string transformers.
 *
 * Each function takes file content (and options) and returns transformed
 * content -- no filesystem or module state. The build spine
 * (`run-mobile-build.mjs`) reads/writes the files and calls these to mutate
 * the text.
 */
import { ensurePlistUrlScheme } from "../lib/ios-plist-url-scheme.mjs";
import { escapeRegExp, escapeXmlText } from "./escape.mjs";

export const IOS_BONJOUR_SERVICES = [
  "_eliza-gw._tcp",
  "_elizaos-gw._tcp",
  "_eliza._tcp",
];

// `audio` keeps the AVAudioSession (and the in-process Bun engine) alive while a
// voice/dictation session runs with the screen locked (#12185 D10). The
// packages/app `patch-ios-plist.mjs` adds it on `cap:sync`; this merger adds it
// on the full build so both plist patchers agree.
const IOS_BACKGROUND_MODES = [
  "fetch",
  "processing",
  "remote-notification",
  "audio",
];
const IOS_BG_TASK_IDENTIFIERS = [
  "ai.eliza.tasks.refresh",
  "ai.eliza.tasks.processing",
];

export function resolveIosPermissionKeys({ appName }) {
  return [
    [
      "NSCameraUsageDescription",
      "This app uses your camera to capture photos and video when you ask it to.",
    ],
    [
      "NSMicrophoneUsageDescription",
      "This app needs microphone access for voice wake, talk mode, and video capture.",
    ],
    [
      "NSLocationWhenInUseUsageDescription",
      "This app uses your location to provide location-aware responses when you allow it.",
    ],
    [
      "NSLocationAlwaysAndWhenInUseUsageDescription",
      "This app can share your location in the background so it stays up to date even when the app is not in use.",
    ],
    [
      "NSPhotoLibraryUsageDescription",
      "This app accesses your photo library to attach and share photos or videos.",
    ],
    [
      "NSPhotoLibraryAddUsageDescription",
      "This app saves captured photos and videos to your photo library.",
    ],
    [
      "NSHealthShareUsageDescription",
      "This app reads your HealthKit sleep and biometric data to infer when you are asleep, awake, and ready for reminders.",
    ],
    [
      "NSHealthUpdateUsageDescription",
      "This app does not write to HealthKit, but iOS requires this key when HealthKit capability is enabled.",
    ],
    [
      "NSSpeechRecognitionUsageDescription",
      "This app uses on-device speech recognition to listen for voice commands and wake words.",
    ],
    [
      "NSLocalNetworkUsageDescription",
      `This app discovers and connects to your ${appName} gateway on the local network.`,
    ],
  ];
}

/** Set (or insert before `</dict>`) a `<key>`/`<string>` pair in a plist. */
export function replaceOrInsertPlistString(content, key, value) {
  const escapedValue = escapeXmlText(value);
  const keyRe = escapeRegExp(key);
  const existingRe = new RegExp(
    `(<key>${keyRe}</key>\\s*<string>)[^<]*(</string>)`,
  );
  if (existingRe.test(content)) {
    return content.replace(existingRe, `$1${escapedValue}$2`);
  }
  return content.replace(
    "</dict>",
    `\t<key>${key}</key>\n\t<string>${escapedValue}</string>\n</dict>`,
  );
}

/** Ensure a plist carries `<key>…</key><true/>` (idempotent). */
export function ensurePlistTrueBool(content, key) {
  const keyRe = escapeRegExp(key);
  if (new RegExp(`<key>${keyRe}</key>`).test(content)) {
    return content;
  }
  return content.replace(
    "</dict>",
    `\t<key>${key}</key>\n\t<true/>\n</dict>`,
  );
}

/** Ensure a plist `<array>` under `key` contains every value in `values`. */
export function ensurePlistArrayStrings(content, key, values) {
  const escapedValues = values.map(escapeXmlText);
  const keyRe = escapeRegExp(key);
  const arrayRe = new RegExp(
    `(<key>${keyRe}</key>\\s*<array>)([\\s\\S]*?)(\\s*</array>)`,
  );
  const match = content.match(arrayRe);
  if (!match) {
    const body = escapedValues
      .map((value) => `\t\t<string>${value}</string>`)
      .join("\n");
    return insertBeforeRootPlistDictClose(
      content,
      `\t<key>${key}</key>\n\t<array>\n${body}\n\t</array>\n</dict>`,
    );
  }
  let body = match[2];
  for (const value of escapedValues) {
    if (!body.includes(`<string>${value}</string>`)) {
      body += `\n\t\t<string>${value}</string>`;
    }
  }
  return content.replace(arrayRe, `$1${body}$3`);
}

/** Insert text immediately before the plist's root `</dict>`. */
export function insertBeforeRootPlistDictClose(content, insertion) {
  const rootClose = "\n</dict>\n</plist>";
  const index = content.lastIndexOf(rootClose);
  if (index >= 0) {
    return `${content.slice(0, index)}\n${insertion}${content.slice(index + "\n</dict>".length)}`;
  }
  const fallbackIndex = content.lastIndexOf("</dict>");
  if (fallbackIndex < 0) return content;
  return `${content.slice(0, fallbackIndex)}${insertion}${content.slice(fallbackIndex + "</dict>".length)}`;
}

/** Rewrite hard-coded `group.<bundle>` app-group ids to the build's app group. */
export function replaceIosAppGroupPlaceholders(content, appGroup) {
  return content.replace(
    /(^|[^A-Za-z0-9_.-])group\.(ai\.elizaos\.app|app\.eliza|com\.elizaai\.eliza)(?![A-Za-z0-9_.-])/g,
    `$1${appGroup}`,
  );
}

/** Remove the named id entries from a pbxproj list section. */
export function removePbxListEntries(content, ids) {
  let next = content;
  for (const id of ids) {
    next = next.replace(
      new RegExp(`\\n\\t+${escapeRegExp(id)} /\\* [^\\n]+ \\*/,`, "g"),
      "",
    );
  }
  return next;
}

export function mergeIosInfoPlist(
  content,
  { appName, urlScheme, displayName = "$(ELIZA_DISPLAY_NAME)" },
) {
  let nextContent = content;
  for (const [key, desc] of resolveIosPermissionKeys({ appName })) {
    if (!nextContent.includes(key)) {
      nextContent = nextContent.replace(
        "</dict>",
        `\t<key>${key}</key>\n\t<string>${desc}</string>\n</dict>`,
      );
    }
  }
  nextContent = ensurePlistUrlScheme(
    ensurePlistArrayStrings(
      ensurePlistArrayStrings(
        ensurePlistArrayStrings(
          replaceOrInsertPlistString(
            nextContent,
            "CFBundleDisplayName",
            displayName,
          ),
          "NSBonjourServices",
          IOS_BONJOUR_SERVICES,
        ),
        "UIBackgroundModes",
        IOS_BACKGROUND_MODES,
      ),
      "BGTaskSchedulerPermittedIdentifiers",
      IOS_BG_TASK_IDENTIFIERS,
    ),
    urlScheme,
  );
  // Live Activities (voice/dictation session on Lock Screen + Dynamic Island,
  // #12185) require this opt-in in the app Info.plist.
  nextContent = ensurePlistTrueBool(nextContent, "NSSupportsLiveActivities");
  return {
    changed: nextContent !== content,
    content: nextContent,
  };
}
