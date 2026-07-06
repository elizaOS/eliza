/** Supports app-core build, packaging, or development orchestration for android manifest mjs. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function appendMissingAndroidManifestBlock(xml, marker, block) {
  if (xml.includes(marker)) return xml;
  return xml.replace("</manifest>", `${block}\n</manifest>`);
}

export function appendMissingApplicationBlock(xml, marker, block) {
  if (xml.includes(marker)) return xml;
  return xml.replace("</application>", `${block}\n    </application>`);
}

export function removeApplicationComponentBlock(xml, componentName) {
  const escapedName = escapeRegExp(componentName);
  const pairedRe = new RegExp(
    `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="${escapedName}")[\\s\\S]*?<\\/\\1>\\s*`,
    "g",
  );
  const selfClosingRe = new RegExp(
    `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="${escapedName}")[^>]*/>\\s*`,
    "g",
  );
  return xml.replace(selfClosingRe, "\n").replace(pairedRe, "\n");
}

export function removeApplicationComponentClassBlock(xml, className) {
  const escapedName = escapeRegExp(className);
  const pairedRe = new RegExp(
    `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="[^"]*\\.?${escapedName}")[\\s\\S]*?<\\/\\1>\\s*`,
    "g",
  );
  const selfClosingRe = new RegExp(
    `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="[^"]*\\.?${escapedName}")[^>]*/>\\s*`,
    "g",
  );
  return xml.replace(selfClosingRe, "\n").replace(pairedRe, "\n");
}

export function stripXmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

export function removeXmlCommentsContaining(xml, markers) {
  let patched = xml;
  for (const marker of markers) {
    const escapedMarker = escapeRegExp(marker);
    // Match a SINGLE comment whose body contains the marker. The body pattern
    // `(?:(?!-->)[\s\S])*?` refuses to cross a closing `-->`, so the match can
    // no longer span from one comment, through real markup we must keep (e.g.
    // the MainActivity @xml/shortcuts meta-data), into a later comment that
    // merely mentions the marker. Without the boundary guard the unbounded
    // `[\s\S]*?` deleted the intervening markup and tripped the android-cloud
    // "does not register @xml/shortcuts" audit (elizaOS/eliza#14408).
    patched = patched.replace(
      new RegExp(
        `\\n?\\s*<!--(?:(?!-->)[\\s\\S])*?${escapedMarker}(?:(?!-->)[\\s\\S])*?-->\\s*`,
        "g",
      ),
      "\n",
    );
  }
  return patched;
}

function ensureManifestToolsNamespace(xml) {
  if (/\bxmlns:tools=/.test(xml)) return xml;
  return xml.replace(
    /<manifest\b([^>]*)>/,
    '<manifest$1 xmlns:tools="http://schemas.android.com/tools">',
  );
}

export function hasAndroidPermissionRequest(xml, fullPermissionName) {
  const escaped = escapeRegExp(fullPermissionName);
  const re = new RegExp(
    `<uses-permission\\b(?=[^>]*android:name="${escaped}")[^>]*>`,
    "g",
  );
  for (const match of xml.matchAll(re)) {
    if (!/\btools:node\s*=\s*"remove"/.test(match[0])) return true;
  }
  return false;
}

export function removeAndroidPermissionRequests(xml, permissions) {
  let patched = xml;
  for (const perm of permissions) {
    const escaped = escapeRegExp(`android.permission.${perm}`);
    const re = new RegExp(
      `\\n\\s*<uses-permission\\b(?=[^>]*android:name="${escaped}")(?![^>]*tools:node="remove")[^>]*/>\\s*`,
      "g",
    );
    patched = patched.replace(re, "\n");
  }
  return patched;
}

export function ensureAndroidPermissionRemovalMarkers(xml, permissions) {
  let patched = ensureManifestToolsNamespace(xml);
  for (const perm of permissions) {
    const full = `android.permission.${perm}`;
    const escaped = escapeRegExp(full);
    const removalRe = new RegExp(
      `<uses-permission\\b(?=[^>]*android:name="${escaped}")(?=[^>]*tools:node="remove")[^>]*/>`,
      "m",
    );
    if (removalRe.test(patched)) continue;
    patched = patched.replace(
      "</manifest>",
      `    <uses-permission android:name="${full}" tools:node="remove" />\n</manifest>`,
    );
  }
  return patched;
}

export function ensureManifestApplicationClosedBeforeTopLevelEntries(xml) {
  if (xml.includes("</application>")) return xml;
  const appStart = xml.indexOf("<application");
  if (appStart === -1) return xml;
  const afterApplicationStart = xml.indexOf(">", appStart);
  if (afterApplicationStart === -1) return xml;
  const afterApplication = xml.slice(afterApplicationStart + 1);
  const topLevelEntry = afterApplication.search(
    /\n\s*<(?:uses-permission|uses-feature)\b/,
  );
  if (topLevelEntry !== -1) {
    const insertAt = afterApplicationStart + 1 + topLevelEntry;
    return `${xml.slice(0, insertAt)}\n    </application>\n${xml.slice(insertAt)}`;
  }
  return xml.replace("</manifest>", "    </application>\n</manifest>");
}

function removeElizaOsHomeActivityFilter(xml) {
  return xml.replace(
    /\n\s*<intent-filter>\s*<action\s+android:name="android\.intent\.action\.MAIN"\s*\/>\s*<category\s+android:name="android\.intent\.category\.HOME"\s*\/>\s*<category\s+android:name="android\.intent\.category\.DEFAULT"\s*\/>\s*<\/intent-filter>\s*/g,
    "\n",
  );
}

export function ensureElizaOsActivityFilters(xml, { enabled = true } = {}) {
  if (!enabled) {
    return removeElizaOsHomeActivityFilter(xml);
  }
  if (xml.includes("android.intent.category.HOME")) {
    return xml;
  }
  const mainActivityRe =
    /(<activity\b(?=[\s\S]*?android:name="\.?MainActivity")[\s\S]*?)(\n\s*<\/activity>)/m;
  const homeFilter = `
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.HOME" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
`;
  return xml.replace(mainActivityRe, `$1${homeFilter}$2`);
}

export function ensureAndroidMainActivityUrlSchemeFilter(xml, { urlScheme }) {
  const mainActivityRe =
    /(<activity\b(?=[\s\S]*?android:name="\.?MainActivity")[\s\S]*?)(\n\s*<\/activity>)/m;
  const match = xml.match(mainActivityRe);
  if (!match) return xml;

  const mainActivity = `${match[1]}${match[2]}`;
  const hasCustomSchemeFilter =
    mainActivity.includes("android.intent.action.VIEW") &&
    mainActivity.includes("android.intent.category.BROWSABLE") &&
    (mainActivity.includes('android:scheme="@string/custom_url_scheme"') ||
      mainActivity.includes(`android:scheme="${urlScheme}"`));
  if (hasCustomSchemeFilter) return xml;

  const authFilter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="@string/custom_url_scheme" />
            </intent-filter>
`;
  return xml.replace(mainActivityRe, `$1${authFilter}$2`);
}

export function ensureAndroidMainActivityShortcutsMetadata(xml) {
  const mainActivityRe =
    /(<activity\b(?=[\s\S]*?android:name="\.?MainActivity")[\s\S]*?)(\n\s*<\/activity>)/m;
  const match = xml.match(mainActivityRe);
  if (!match) return xml;

  const mainActivity = `${match[1]}${match[2]}`;
  if (
    mainActivity.includes('android:name="android.app.shortcuts"') &&
    mainActivity.includes('android:resource="@xml/shortcuts"')
  ) {
    return xml;
  }

  const shortcutsMetadata = `
            <meta-data
                android:name="android.app.shortcuts"
                android:resource="@xml/shortcuts" />
`;
  return xml.replace(mainActivityRe, `$1${shortcutsMetadata}$2`);
}

export function patchAndroidAppActionsXmlResource(
  xml,
  { androidPackage, urlScheme },
) {
  let patched = xml
    .replace(
      /\bandroid:targetPackage="[^"]+"/g,
      `android:targetPackage="${androidPackage}"`,
    )
    .replace(
      /\bandroid:targetClass="[^"]*\.MainActivity"/g,
      `android:targetClass="${androidPackage}.MainActivity"`,
    );

  const escapedSchemes = [
    "eliza",
    "elizaos",
    "ai.elizaos.app",
    "app.eliza",
    androidPackage,
  ].filter(Boolean);
  for (const scheme of escapedSchemes) {
    patched = patched.replace(
      new RegExp(`${escapeRegExp(scheme)}://`, "g"),
      `${urlScheme}://`,
    );
  }

  return patched;
}

export const ANDROID_APP_ACTION_CAPABILITIES = [
  "actions.intent.OPEN_APP_FEATURE",
  "actions.intent.CREATE_MESSAGE",
  "actions.intent.GET_THING",
];

export const ANDROID_APP_ACTION_SHORTCUT_IDS = [
  "eliza_app_action_chat",
  "eliza_app_action_voice",
  "eliza_app_action_daily_brief",
  "eliza_app_action_new_task",
  "eliza_app_action_tasks",
];

export const ANDROID_APP_ACTION_REQUIRED_DEEP_LINKS = [
  "feature/open?source=android-app-actions",
  "chat?source=android-app-actions&amp;action=ask",
  "chat?source=android-app-actions&amp;action=chat",
  "voice?source=android-static-shortcut",
  "lifeops/daily-brief?source=android-static-shortcut",
  "lifeops/task/new?source=android-static-shortcut",
  "lifeops/tasks?source=android-static-shortcut",
];

export const ANDROID_APP_ACTION_FORBIDDEN_MARKERS = [
  "actions.intent.CREATE_THING",
  "android.intent.action.ASSIST",
  "android.intent.action.VOICE_COMMAND",
  "android.app.role.ASSISTANT",
  "android.permission.BIND_VOICE_INTERACTION",
  "assistant/open",
];

function extractAndroidAppActionCapabilityBlocks(xml) {
  const blocks = new Map();
  const capabilityRe =
    /<capability\b[^>]*android:name="(actions\.intent\.[^"]+)"[^>]*>([\s\S]*?)<\/capability>/g;
  for (const match of xml.matchAll(capabilityRe)) {
    blocks.set(match[1], match[2]);
  }
  return blocks;
}

export function validateAndroidAppActionsXmlResource(
  xml,
  { androidPackage, urlScheme },
) {
  const failures = [];
  const capabilityBlocks = extractAndroidAppActionCapabilityBlocks(xml);

  for (const capability of ANDROID_APP_ACTION_CAPABILITIES) {
    if (!xml.includes(`android:name="${capability}"`)) {
      failures.push(`shortcuts.xml is missing ${capability}`);
    }
    const block = capabilityBlocks.get(capability);
    if (!block) continue;
    const intentBlocks = [
      ...block.matchAll(/<intent\b[^>]*\/>|<intent\b[\s\S]*?<\/intent>/g),
    ].map((match) => match[0]);
    const hasFallbackIntent = intentBlocks.some(
      (intent) => !/android:required="true"/.test(intent),
    );
    if (!hasFallbackIntent) {
      failures.push(
        `shortcuts.xml ${capability} is missing a no-required-parameter fallback intent`,
      );
    }
  }

  for (const match of xml.matchAll(
    /\bandroid:name="(actions\.intent\.[^"]+)"/g,
  )) {
    const action = match[1];
    if (!ANDROID_APP_ACTION_CAPABILITIES.includes(action)) {
      failures.push(`shortcuts.xml declares unsupported App Action ${action}`);
    }
  }

  for (const shortcutId of ANDROID_APP_ACTION_SHORTCUT_IDS) {
    if (!xml.includes(`android:shortcutId="${shortcutId}"`)) {
      failures.push(`shortcuts.xml is missing ${shortcutId}`);
    }
  }

  for (const source of ["android-app-actions", "android-static-shortcut"]) {
    if (!xml.includes(`source=${source}`)) {
      failures.push(`shortcuts.xml is missing source=${source} deep links`);
    }
  }

  for (const deepLink of ANDROID_APP_ACTION_REQUIRED_DEEP_LINKS) {
    if (!xml.includes(`${urlScheme}://${deepLink}`)) {
      failures.push(`shortcuts.xml is missing ${urlScheme}://${deepLink}`);
    }
  }

  for (const marker of ANDROID_APP_ACTION_FORBIDDEN_MARKERS) {
    if (xml.includes(marker)) {
      failures.push(`shortcuts.xml contains forbidden marker ${marker}`);
    }
  }

  for (const match of xml.matchAll(/\bandroid:targetPackage="([^"]+)"/g)) {
    if (match[1] !== androidPackage) {
      failures.push(
        `shortcuts.xml targetPackage ${match[1]} was not rewritten to ${androidPackage}`,
      );
    }
  }

  const expectedTargetClass = `${androidPackage}.MainActivity`;
  for (const match of xml.matchAll(/\bandroid:targetClass="([^"]+)"/g)) {
    if (match[1] !== expectedTargetClass) {
      failures.push(
        `shortcuts.xml targetClass ${match[1]} was not rewritten to ${expectedTargetClass}`,
      );
    }
  }

  if (!xml.includes(`${urlScheme}://`)) {
    failures.push(
      `shortcuts.xml URL templates were not rewritten to ${urlScheme}://`,
    );
  }

  const staleLiterals = [
    androidPackage === "app.eliza" ? null : 'android:targetPackage="app.eliza"',
    androidPackage === "ai.elizaos.app"
      ? null
      : 'android:targetClass="ai.elizaos.app.MainActivity"',
    urlScheme === "eliza" ? null : "eliza://",
    urlScheme === "ai.elizaos.app" ? null : "ai.elizaos.app://",
    urlScheme === "app.eliza" ? null : "app.eliza://",
  ].filter(Boolean);
  for (const stale of staleLiterals) {
    if (xml.includes(stale)) {
      failures.push(`shortcuts.xml still contains stale literal ${stale}`);
    }
  }

  return failures;
}

export function applyAndroidCleartextPolicy(xml, { allowCleartext }) {
  const value = allowCleartext ? "true" : "false";
  if (/android:usesCleartextTraffic="(?:true|false)"/.test(xml)) {
    return xml.replace(
      /android:usesCleartextTraffic="(?:true|false)"/g,
      `android:usesCleartextTraffic="${value}"`,
    );
  }
  return xml.replace(
    "<application",
    `<application\n        android:usesCleartextTraffic="${value}"`,
  );
}
