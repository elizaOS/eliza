/** Owns android manifest policy using the shared build context and existing platform contracts. */
import {
  appendMissingApplicationBlock,
  removeApplicationComponentBlock,
  removeApplicationComponentClassBlock,
} from "../android-manifest.mjs";

// ── Phase 4: Android native overlay ─────────────────────────────────────

/** Permissions that Capacitor sync doesn't generate (it only adds INTERNET). */
export const ANDROID_PERMISSIONS = [
  "READ_CONTACTS",
  "WRITE_CONTACTS",
  "CALL_PHONE",
  "READ_PHONE_STATE",
  "ANSWER_PHONE_CALLS",
  "MANAGE_OWN_CALLS",
  "READ_CALL_LOG",
  "WRITE_CALL_LOG",
  "READ_SMS",
  "SEND_SMS",
  "RECEIVE_SMS",
  "RECEIVE_MMS",
  "RECEIVE_WAP_PUSH",
  "RECORD_AUDIO",
  "CAMERA",
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "ACCESS_BACKGROUND_LOCATION",
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_DATA_SYNC",
  "FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "FOREGROUND_SERVICE_SPECIAL_USE",
  "POST_NOTIFICATIONS",
  "WAKE_LOCK",
  "RECEIVE_BOOT_COMPLETED",
  "SYSTEM_ALERT_WINDOW",
  // PACKAGE_USAGE_STATS is granted via the privapp-permissions whitelist;
  // MANAGE_APP_OPS_MODES is what ElizaBootReceiver actually needs to
  // reflectively flip the GET_USAGE_STATS appop to ALLOWED at boot.
  // Without MANAGE_APP_OPS_MODES the receiver throws SecurityException
  // and PACKAGE_USAGE_STATS stays appop-default-denied, which breaks
  // priv-app usage-stats access. See vendor/eliza/permissions/
  // privapp-permissions-com.elizaai.eliza.xml.
  "PACKAGE_USAGE_STATS",
  "MANAGE_APP_OPS_MODES",
  "MANAGE_VIRTUAL_MACHINE",
  "READ_FRAME_BUFFER",
  "INJECT_EVENTS",
  "REAL_GET_TASKS",
];

export function androidAospRoleLauncherIntentFilter({
  enabled = false,
  category = null,
} = {}) {
  if (!enabled) return "";
  const extraCategory = category
    ? `\n                <category android:name="${category}" />`
    : "";
  return `
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />${extraCategory}
            </intent-filter>`;
}

/**
 * Replaces the boot receiver with the exact block shipped by local-capable
 * Android targets. Keeping this transformation pure lets tests inspect the
 * post-overlay manifest instead of only the platform input template.
 */
export function ensureElizaBootReceiverManifest(xml, androidPackage) {
  let next = removeApplicationComponentBlock(
    xml,
    `${androidPackage}.ElizaBootReceiver`,
  );
  next = removeApplicationComponentClassBlock(next, "ElizaBootReceiver");
  return appendMissingApplicationBlock(
    next,
    `${androidPackage}.ElizaBootReceiver`,
    `
        <receiver
            android:name="${androidPackage}.ElizaBootReceiver"
            android:directBootAware="true"
            android:exported="false">
            <intent-filter>
                <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>`,
  );
}
