/** Owns android overlay using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import {
  appendMissingAndroidManifestBlock,
  appendMissingApplicationBlock,
  applyAndroidCleartextPolicy,
  ensureAndroidMainActivityShortcutsMetadata,
  ensureAndroidMainActivityUrlSchemeFilter,
  ensureElizaOsActivityFilters,
  removeApplicationComponentBlock,
  removeApplicationComponentClassBlock,
} from "../android-manifest.mjs";
import { rmRecursive } from "../build-tools.mjs";
import { APP, androidDir, platformsDir, repoRoot } from "../context.mjs";
import { escapeJavaString, escapeRegExp } from "../escape.mjs";
import {
  ANDROID_PERMISSIONS,
  androidAospRoleLauncherIntentFilter,
  ensureElizaBootReceiverManifest,
} from "./manifest-policy.mjs";
import {
  assertSharedTreeOnlyForEliza,
  packageNameToPath,
} from "./shared-tree.mjs";

export function shouldRemoveAndroidJavaSourceRoot(
  candidate,
  dstJava,
  protectedRoots = [],
) {
  const normalized = path.resolve(candidate);
  if (normalized === path.resolve(dstJava)) return false;
  return !protectedRoots.some((root) => normalized === path.resolve(root));
}

export function removeStaleAndroidJavaSourceRoots(
  dstJava,
  { protectedRoots = [] } = {},
) {
  const candidates = [
    "ai.elizaos.app",
    "com.elizaai.eliza",
    "com.elizaai.eliza",
    APP.appId,
  ];
  for (const packageName of candidates) {
    const candidate = path.join(
      androidDir,
      "app",
      "src",
      "main",
      "java",
      packageNameToPath(packageName),
    );
    if (
      shouldRemoveAndroidJavaSourceRoot(candidate, dstJava, protectedRoots) &&
      fs.existsSync(candidate)
    ) {
      rmRecursive(candidate);
    }
  }
}

// Replace the BRAND_USER_AGENT_MARKERS array contents in the templated
// MainActivity.java with framework default + entries from
// `app.config.ts > android.userAgentMarkers`. Idempotent: re-running on
// already-injected source produces the same result because we re-emit
// the canonical default + configured set every time.
export function injectBrandUserAgentMarkers(javaSource, markers) {
  const arrayRe =
    /(private static final UserAgentMarker\[\] BRAND_USER_AGENT_MARKERS = new UserAgentMarker\[\]\s*\{)([\s\S]*?)(\};)/m;
  if (!arrayRe.test(javaSource)) {
    return javaSource;
  }
  const lines = [
    `        new UserAgentMarker("ro.elizaos.product", "ElizaOS/"),`,
  ];
  for (const marker of markers) {
    const systemProp = escapeJavaString(marker.systemProp);
    const uaPrefix = escapeJavaString(marker.uaPrefix);
    lines.push(`        new UserAgentMarker("${systemProp}", "${uaPrefix}"),`);
  }
  return javaSource.replace(arrayRe, `$1\n${lines.join("\n")}\n    $3`);
}

export function writeAndroidCleartextPolicy({ allowCleartext, label }) {
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!fs.existsSync(manifestPath)) return;
  const xml = fs.readFileSync(manifestPath, "utf8");
  const patched = applyAndroidCleartextPolicy(xml, { allowCleartext });
  if (patched !== xml) {
    fs.writeFileSync(manifestPath, patched, "utf8");
    console.log(
      `[mobile-build] Android ${label} cleartext policy: ${allowCleartext ? "enabled for local loopback" : "disabled"}.`,
    );
  }
}

export function restoreAndroidManifestFromPlatformTemplateIfMissing() {
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) return false;

  const templatePath = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!fs.existsSync(templatePath)) return false;

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.copyFileSync(templatePath, manifestPath);
  console.log(
    `[mobile-build] Restored missing AndroidManifest.xml from ${path.relative(
      repoRoot,
      templatePath,
    )}.`,
  );
  return true;
}

export function overlayAndroid({
  includeAospRoleLaunchers = false,
  includeHomeRole = includeAospRoleLaunchers,
} = {}) {
  assertSharedTreeOnlyForEliza("overlay Java sources");
  const templateJavaRoot = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "java",
  );
  const templateJava =
    [
      path.join(templateJavaRoot, "ai", "elizaos", "app"),
      path.join(templateJavaRoot, "app", "eliza"),
    ].find((candidate) => fs.existsSync(candidate)) ??
    path.join(templateJavaRoot, "ai", "elizaos", "app");
  const gradlePath = path.join(androidDir, "app", "build.gradle");
  const androidPackage = APP.appId;
  const dstJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(androidPackage),
  );
  const legacyJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    "ai",
    "elizaos",
    "app",
  );
  const appIdJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    ...APP.appId.split("."),
  );
  const defaultJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    "app",
    "eliza",
  );
  const srcJava =
    [templateJava, dstJava, defaultJava, legacyJava].find((candidate) =>
      fs.existsSync(candidate),
    ) ?? templateJava;

  if (fs.existsSync(srcJava)) {
    const protectedJavaRoots = [srcJava, dstJava];
    removeStaleAndroidJavaSourceRoots(dstJava, {
      protectedRoots: protectedJavaRoots,
    });
    for (const staleJava of [legacyJava, appIdJava, defaultJava]) {
      if (
        shouldRemoveAndroidJavaSourceRoot(
          staleJava,
          dstJava,
          protectedJavaRoots,
        )
      ) {
        rmRecursive(staleJava);
      }
    }
    fs.mkdirSync(dstJava, { recursive: true });
    // Move EVERY .java file in the source package — never a hardcoded list. A
    // fixed list silently drops newly-added files (e.g. ElizaVoicePlugin.java /
    // ElizaVoiceNative.java from the fused-voice work), so the white-label
    // package overlay leaves them in the legacy package while MainActivity (and
    // the other moved files) reference them → "cannot find symbol" /
    // "package R does not exist" and the whole white-label build fails. The
    // package/import rewrite below makes any file in `ai.elizaos.app` resolve
    // under the brand package, so moving all of them is always correct.
    const javaFilesToOverlay = fs.existsSync(srcJava)
      ? fs.readdirSync(srcJava).filter((name) => name.endsWith(".java"))
      : [];
    for (const file of javaFilesToOverlay) {
      const src = path.join(srcJava, file);
      if (!fs.existsSync(src)) continue;
      let code = fs.readFileSync(src, "utf8");
      code = code.replace(
        /^package\s+(?:ai\.elizaos\.app|app\.eliza);/m,
        `package ${androidPackage};`,
      );
      code = code.replaceAll(
        "ai.elizaos.app.action.",
        `${androidPackage}.action.`,
      );
      // Generated symbols follow the Gradle namespace. Rewrite stale imports
      // from either the legacy package or the default package so R/BuildConfig
      // resolve after the package overlay.
      code = code.replaceAll(
        /\bimport\s+(?:ai\.elizaos\.app|app\.eliza)\.(BuildConfig|R)\s*;/g,
        `import ${androidPackage}.$1;`,
      );
      code = code.replaceAll("ai.elizaos.app://", `${APP.urlScheme}://`);
      code = code.replaceAll(
        "elizaOS Gateway",
        `${escapeJavaString(APP.appName)} Gateway`,
      );
      code = code.replaceAll(
        "Shows elizaOS gateway connection status",
        `Shows ${escapeJavaString(APP.appName)} gateway connection status`,
      );
      if (file === "MainActivity.java") {
        code = injectBrandUserAgentMarkers(code, APP.userAgentMarkers ?? []);
      }
      fs.writeFileSync(path.join(dstJava, file), code, "utf8");
      // Rewrite the legacy-package copy's R/BuildConfig imports so any file left
      // behind in the old package still resolves — but ONLY when that copy lives
      // in THIS build's own android dir. NEVER write into the shared elizaOS
      // template tree (platforms/android): a whitelabel build
      // (ELIZA_ANDROID_USE_APP_DIR) reads that template READ-ONLY, and writing
      // the brand package back into it corrupts the elizaOS checkout's
      // ai/elizaos/app sources (the recurring "custom package does not exist"
      // pollution that breaks the next elizaOS build). srcJava resolves
      // to templateJava for a whitelabel build, so this guard is what keeps the
      // two brands' source trees separate.
      const srcInOwnAndroidDir = path
        .resolve(src)
        .startsWith(`${path.resolve(androidDir)}${path.sep}`);
      if (
        srcInOwnAndroidDir &&
        path.resolve(src) !== path.resolve(path.join(dstJava, file))
      ) {
        const legacyCode = fs
          .readFileSync(src, "utf8")
          .replaceAll(
            /\bimport\s+(?:ai\.elizaos\.app|app\.eliza)\.(BuildConfig|R)\s*;/g,
            `import ${androidPackage}.$1;`,
          );
        fs.writeFileSync(src, legacyCode, "utf8");
      }
    }
    if (
      path.resolve(srcJava) !== path.resolve(templateJava) &&
      path.resolve(srcJava) !== path.resolve(dstJava)
    ) {
      rmRecursive(srcJava);
    }
    console.log("[mobile-build] Overlaid Android Java sources.");
  }
  const templateElizaVoiceJni = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "elizavoice-jni",
  );
  const targetElizaVoiceJni = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "elizavoice-jni",
  );
  if (
    fs.existsSync(templateElizaVoiceJni) &&
    path.resolve(templateElizaVoiceJni) !== path.resolve(targetElizaVoiceJni)
  ) {
    rmRecursive(targetElizaVoiceJni);
    fs.cpSync(templateElizaVoiceJni, targetElizaVoiceJni, { recursive: true });
    console.log("[mobile-build] Overlaid Android elizavoice JNI sources.");
  }

  // Merge AndroidManifest.xml
  restoreAndroidManifestFromPlatformTemplateIfMissing();
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) {
    let xml = fs.readFileSync(manifestPath, "utf8");
    let dirty = false;

    const withLocalCleartext = applyAndroidCleartextPolicy(xml, {
      allowCleartext: true,
    });
    if (withLocalCleartext !== xml) {
      xml = withLocalCleartext;
      dirty = true;
    }
    if (!xml.includes("<queries>")) {
      xml = xml.replace(
        /(\s*)<application/,
        '\n    <queries>\n        <package android:name="com.google.android.apps.healthdata" />\n    </queries>\n\n    <application',
      );
      dirty = true;
    }
    xml = appendMissingAndroidManifestBlock(
      xml,
      "android.hardware.telephony",
      '    <uses-feature android:name="android.hardware.telephony" android:required="false" />',
    );
    const withElizaOsActivityFilters = ensureElizaOsActivityFilters(xml, {
      enabled: includeHomeRole,
    });
    if (withElizaOsActivityFilters !== xml) {
      xml = withElizaOsActivityFilters;
      dirty = true;
    }
    const withUrlSchemeFilter = ensureAndroidMainActivityUrlSchemeFilter(xml, {
      urlScheme: APP.urlScheme,
    });
    if (withUrlSchemeFilter !== xml) {
      xml = withUrlSchemeFilter;
      dirty = true;
    }
    const withShortcutsMetadata =
      ensureAndroidMainActivityShortcutsMetadata(xml);
    if (withShortcutsMetadata !== xml) {
      xml = withShortcutsMetadata;
      dirty = true;
    }
    const gatewayServiceName = `${androidPackage}.GatewayConnectionService`;
    const gatewayServicePattern =
      /\n\s*<service\b[^>]*android:name="[^"]*GatewayConnectionService"[^>]*\/>\s*/g;
    const withoutGatewayServices = xml.replace(gatewayServicePattern, "\n");
    if (withoutGatewayServices !== xml) {
      xml = withoutGatewayServices;
      dirty = true;
    }
    xml = xml.replace(
      "</application>",
      `\n        <service\n            android:name="${gatewayServiceName}"\n            android:exported="false"\n            android:foregroundServiceType="dataSync" />\n    </application>`,
    );
    dirty = true;

    // ElizaAgentService — special-use foreground service that owns the
    // local Eliza agent process. Nested <property> tag carries the Android
    // 14+ specialUse subtype. Pattern matches both self-closing and
    // explicit-close forms so re-runs collapse cleanly.
    const agentServiceName = `${androidPackage}.ElizaAgentService`;
    const agentServiceSelfClosingPattern =
      /\n\s*<service\b[^>]*android:name="[^"]*ElizaAgentService"[^>]*\/>\s*/g;
    const agentServicePairedPattern =
      /\n\s*<service\b[^>]*android:name="[^"]*ElizaAgentService"[\s\S]*?<\/service>\s*/g;
    const withoutAgentServiceSelfClose = xml.replace(
      agentServiceSelfClosingPattern,
      "\n",
    );
    if (withoutAgentServiceSelfClose !== xml) {
      xml = withoutAgentServiceSelfClose;
      dirty = true;
    }
    const withoutAgentServicePaired = xml.replace(
      agentServicePairedPattern,
      "\n",
    );
    if (withoutAgentServicePaired !== xml) {
      xml = withoutAgentServicePaired;
      dirty = true;
    }
    xml = xml.replace(
      "</application>",
      `\n        <service\n            android:name="${agentServiceName}"\n            android:exported="false"\n            android:foregroundServiceType="specialUse">\n            <property\n                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"\n                android:value="local-agent-runtime" />\n        </service>\n    </application>`,
    );
    dirty = true;
    for (const component of [
      "ElizaDialActivity",
      "ElizaAssistActivity",
      "ElizaQuickActionsWidgetProvider",
      "ElizaShareActivity",
      "ElizaVoiceTileService",
      "ElizaAccessibilityService",
      "ElizaInCallService",
      "ElizaNotificationListenerService",
      "ElizaSmsReceiver",
      "ElizaMmsReceiver",
      "ElizaSmsGatewayService",
      "ElizaRespondViaMessageService",
      "ElizaSmsComposeActivity",
      "ElizaBootReceiver",
      "ElizaBrowserActivity",
      "ElizaContactsActivity",
      "ElizaCameraActivity",
      "ElizaClockActivity",
      "ElizaCalendarActivity",
    ]) {
      const nextXml = removeApplicationComponentBlock(
        xml,
        `${androidPackage}.${component}`,
      );
      if (nextXml !== xml) {
        xml = nextXml;
        dirty = true;
      }
    }
    for (const component of [
      "ElizaDialActivity",
      "ElizaAssistActivity",
      "ElizaQuickActionsWidgetProvider",
      "ElizaShareActivity",
      "ElizaVoiceTileService",
      "ElizaAccessibilityService",
      "ElizaInCallService",
      "ElizaNotificationListenerService",
      "ElizaSmsReceiver",
      "ElizaMmsReceiver",
      "ElizaSmsGatewayService",
      "ElizaRespondViaMessageService",
      "ElizaSmsComposeActivity",
      "ElizaBootReceiver",
      "ElizaBrowserActivity",
      "ElizaContactsActivity",
      "ElizaCameraActivity",
      "ElizaClockActivity",
      "ElizaCalendarActivity",
      "ElizaDialActivity",
      "ElizaAssistActivity",
      "ElizaInCallService",
      "ElizaSmsReceiver",
      "ElizaMmsReceiver",
      "ElizaRespondViaMessageService",
      "ElizaSmsComposeActivity",
      "ElizaBootReceiver",
    ]) {
      const nextXml = removeApplicationComponentClassBlock(xml, component);
      if (nextXml !== xml) {
        xml = nextXml;
        dirty = true;
      }
    }
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaDialActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaDialActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.DIAL" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.DIAL" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="tel" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaAssistActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaAssistActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.ASSIST" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VOICE_COMMAND" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaShareActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaShareActivity"
            android:exported="true"
            android:label="@string/app_action_smart_reply_long"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.PROCESS_TEXT" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaVoiceTileService`,
      `
        <service
            android:name="${androidPackage}.ElizaVoiceTileService"
            android:exported="true"
            android:icon="@mipmap/ic_launcher_monochrome"
            android:label="@string/app_action_voice_long"
            android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
            <intent-filter>
                <action android:name="android.service.quicksettings.action.QS_TILE" />
            </intent-filter>
            <meta-data
                android:name="android.service.quicksettings.TOGGLEABLE_TILE"
                android:value="false" />
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaQuickActionsWidgetProvider`,
      `
        <receiver
            android:name="${androidPackage}.ElizaQuickActionsWidgetProvider"
            android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data
                android:name="android.appwidget.provider"
                android:resource="@xml/eliza_quick_actions_widget" />
        </receiver>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaAccessibilityService`,
      `
        <service
            android:name="${androidPackage}.ElizaAccessibilityService"
            android:exported="true"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/eliza_accessibility_service" />
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaNotificationListenerService`,
      `
        <service
            android:name="${androidPackage}.ElizaNotificationListenerService"
            android:exported="true"
            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaInCallService`,
      `
        <service
            android:name="${androidPackage}.ElizaInCallService"
            android:exported="true"
            android:permission="android.permission.BIND_INCALL_SERVICE">
            <meta-data
                android:name="android.telecom.IN_CALL_SERVICE_UI"
                android:value="true" />
            <meta-data
                android:name="android.telecom.IN_CALL_SERVICE_RINGING"
                android:value="true" />
            <intent-filter>
                <action android:name="android.telecom.InCallService" />
            </intent-filter>
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaSmsReceiver`,
      `
        <receiver
            android:name="${androidPackage}.ElizaSmsReceiver"
            android:exported="true"
            android:permission="android.permission.BROADCAST_SMS">
            <intent-filter>
                <action android:name="android.provider.Telephony.SMS_DELIVER" />
            </intent-filter>
        </receiver>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaMmsReceiver`,
      `
        <receiver
            android:name="${androidPackage}.ElizaMmsReceiver"
            android:exported="true"
            android:permission="android.permission.BROADCAST_WAP_PUSH">
            <intent-filter>
                <action android:name="android.provider.Telephony.WAP_PUSH_DELIVER" />
                <data android:mimeType="application/vnd.wap.mms-message" />
            </intent-filter>
        </receiver>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaSmsGatewayService`,
      `
        <service
            android:name="${androidPackage}.ElizaSmsGatewayService"
            android:exported="false" />`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaRespondViaMessageService`,
      `
        <service
            android:name="${androidPackage}.ElizaRespondViaMessageService"
            android:exported="true"
            android:permission="android.permission.SEND_RESPOND_VIA_MESSAGE">
            <intent-filter>
                <action android:name="android.intent.action.RESPOND_VIA_MESSAGE" />
                <data android:scheme="sms" />
                <data android:scheme="smsto" />
                <data android:scheme="mms" />
                <data android:scheme="mmsto" />
            </intent-filter>
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaSmsComposeActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaSmsComposeActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.SENDTO" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="sms" />
                <data android:scheme="smsto" />
                <data android:scheme="mms" />
                <data android:scheme="mmsto" />
            </intent-filter>
        </activity>`,
    );
    xml = ensureElizaBootReceiverManifest(xml, androidPackage);
    // Browser: replaces stripped Browser2 as the only http(s) handler.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaBrowserActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaBrowserActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="http" />
                <data android:scheme="https" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.WEB_SEARCH" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    // Contacts: replaces stripped Contacts. Handles content://contacts.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaContactsActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaContactsActivity"
            android:exported="true"
            android:label="Contacts"
            android:theme="@style/AppTheme.NoActionBar">${androidAospRoleLauncherIntentFilter(
              {
                enabled: includeAospRoleLaunchers,
                category: "android.intent.category.APP_CONTACTS",
              },
            )}
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.dir/contact" />
                <data android:mimeType="vnd.android.cursor.dir/person" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.item/contact" />
                <data android:mimeType="vnd.android.cursor.item/person" />
            </intent-filter>
        </activity>`,
    );
    // Camera: replaces stripped Camera2. STILL_IMAGE_CAMERA + IMAGE_CAPTURE.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaCameraActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaCameraActivity"
            android:exported="true"
            android:label="Camera"
            android:theme="@style/AppTheme.NoActionBar">${androidAospRoleLauncherIntentFilter(
              {
                enabled: includeAospRoleLaunchers,
              },
            )}
            <intent-filter>
                <action android:name="android.media.action.STILL_IMAGE_CAMERA" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.media.action.IMAGE_CAPTURE" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.media.action.VIDEO_CAPTURE" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    // Clock: replaces stripped DeskClock. SET_ALARM is critical.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaClockActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaClockActivity"
            android:exported="true"
            android:label="Clock"
            android:theme="@style/AppTheme.NoActionBar">${androidAospRoleLauncherIntentFilter(
              {
                enabled: includeAospRoleLaunchers,
              },
            )}
            <intent-filter>
                <action android:name="android.intent.action.SET_ALARM" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SHOW_ALARMS" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SET_TIMER" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SHOW_TIMERS" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.DISMISS_ALARM" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    // Calendar: replaces stripped Calendar.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaCalendarActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaCalendarActivity"
            android:exported="true"
            android:label="Calendar"
            android:theme="@style/AppTheme.NoActionBar">${androidAospRoleLauncherIntentFilter(
              {
                enabled: includeAospRoleLaunchers,
                category: "android.intent.category.APP_CALENDAR",
              },
            )}
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.item/event" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.INSERT" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.dir/event" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.EDIT" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.item/event" />
            </intent-filter>
        </activity>`,
    );
    dirty = true;
    for (const perm of ANDROID_PERMISSIONS) {
      const full = `android.permission.${perm}`;
      if (!xml.includes(full)) {
        xml = xml.replace(
          "</manifest>",
          `    <uses-permission android:name="${full}" />\n</manifest>`,
        );
        dirty = true;
      }
    }
    // Storage permissions with maxSdkVersion
    if (!xml.includes("WRITE_EXTERNAL_STORAGE")) {
      xml = xml.replace(
        "</manifest>",
        '    <uses-permission\n        android:name="android.permission.WRITE_EXTERNAL_STORAGE"\n        android:maxSdkVersion="28" />\n</manifest>',
      );
      dirty = true;
    }
    if (!xml.includes("READ_EXTERNAL_STORAGE")) {
      xml = xml.replace(
        "</manifest>",
        '    <uses-permission\n        android:name="android.permission.READ_EXTERNAL_STORAGE"\n        android:maxSdkVersion="32" />\n</manifest>',
      );
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(manifestPath, xml, "utf8");
      console.log(
        "[mobile-build] Merged permissions and service into AndroidManifest.xml.",
      );
    }
  }

  // Copy ProGuard rules, rewriting the elizaOS default package to match the
  // app's actual namespace. Without this rewrite, R8 may strip Eliza-only
  // manifest-referenced classes (Dial/Assist/InCall/Boot) when the app is
  // namespaced as e.g. com.elizaai.eliza.
  const srcPro = path.join(
    platformsDir,
    "android",
    "app",
    "proguard-rules.pro",
  );
  if (fs.existsSync(srcPro)) {
    let proguardRules = fs.readFileSync(srcPro, "utf8");
    if (androidPackage && androidPackage !== "ai.elizaos.app") {
      proguardRules = proguardRules.replaceAll(
        "ai.elizaos.app.**",
        `${androidPackage}.**`,
      );
    }
    fs.writeFileSync(
      path.join(androidDir, "app", "proguard-rules.pro"),
      proguardRules,
      "utf8",
    );
    console.log("[mobile-build] Copied ProGuard rules.");
  }

  // Enable release minification
  if (fs.existsSync(gradlePath)) {
    let g = fs.readFileSync(gradlePath, "utf8");
    if (g.includes("minifyEnabled false")) {
      g = g.replace(
        "minifyEnabled false",
        "minifyEnabled true\n            shrinkResources true",
      );
      fs.writeFileSync(gradlePath, g, "utf8");
      console.log("[mobile-build] Enabled release minification.");
    }
  }
}

export function sanitizeAndroidManifestWhenPlatformTemplatesMissing() {
  const srcJava = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "java",
    "ai",
    "elizaos",
    "app",
  );
  const activeJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(APP.appId),
  );
  if (fs.existsSync(srcJava) || fs.existsSync(activeJava)) return;

  restoreAndroidManifestFromPlatformTemplateIfMissing();
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!fs.existsSync(manifestPath)) return;

  let xml = fs.readFileSync(manifestPath, "utf8");
  const original = xml;
  const removeComponent = (source, className) => {
    const escapedName = escapeRegExp(className);
    const pairedRe = new RegExp(
      `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="[^"]*\\.?${escapedName}")[\\s\\S]*?<\\/\\1>\\s*`,
      "g",
    );
    const selfClosingRe = new RegExp(
      `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="[^"]*\\.?${escapedName}")[^>]*/>\\s*`,
      "g",
    );
    return source.replace(pairedRe, "\n").replace(selfClosingRe, "\n");
  };

  for (const component of [
    "ElizaAgentService",
    "ElizaDialActivity",
    "ElizaAssistActivity",
    "ElizaVoiceInteractionService",
    "ElizaVoiceInteractionSessionService",
    "ElizaRecognitionService",
    "ElizaVoiceInputMethodService",
    "ElizaQuickActionsWidgetProvider",
    "ElizaShareActivity",
    "ElizaVoiceTileService",
    "ElizaInCallService",
    "ElizaSmsReceiver",
    "ElizaMmsReceiver",
    "ElizaSmsGatewayService",
    "ElizaRespondViaMessageService",
    "ElizaSmsComposeActivity",
    "ElizaBootReceiver",
    "ElizaBrowserActivity",
    "ElizaContactsActivity",
    "ElizaCameraActivity",
    "ElizaClockActivity",
    "ElizaCalendarActivity",
  ]) {
    xml = removeComponent(xml, component);
  }
  if (xml !== original) {
    fs.writeFileSync(manifestPath, xml, "utf8");
    console.log(
      "[mobile-build] Removed Android components that need packaged platform templates.",
    );
  }
}
