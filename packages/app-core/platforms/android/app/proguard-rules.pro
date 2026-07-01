# elizaOS ProGuard/R8 Rules
# =========================

# Capacitor — keep the bridge and plugin classes
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class com.getcapacitor.community.** { *; }

# elizaOS custom Capacitor plugins.
#
# Two package roots are in play and BOTH must be kept:
#   - ai.elizaos.plugins.*  (only plugin-native-bun-runtime uses this)
#   - ai.eliza.plugins.*    (every other @elizaos/capacitor-* native plugin:
#                            websiteblocker, appblocker, camera, gateway,
#                            location, screencapture, swabble, talkmode, …)
#
# The ai.eliza.plugins.* root in particular contains manifest-declared
# components that Android instantiates by name — most critically
# ai.eliza.plugins.websiteblocker.WebsiteBlockerBootReceiver (BOOT_COMPLETED)
# and WebsiteBlockerVpnService. Those have no @CapacitorPlugin annotation and
# no other code reference, so without an explicit keep R8 strips them from the
# release dex and the merged-manifest receiver crash-loops the app at boot with
# ClassNotFoundException. Keep the whole native-plugin namespace.
-keep class ai.elizaos.plugins.** { *; }
-keep class ai.eliza.plugins.** { *; }
-keep class app.eliza.** { *; }

# WebView JavaScript interface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# OkHttp (used by gateway plugin)
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# Kotlin coroutines
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}

# AndroidX
-keep class androidx.** { *; }
-keep interface androidx.** { *; }

# Keep source file names and line numbers for crash reports
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Preserve annotations
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes Exceptions

# Firebase/GMS (if present)
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.firebase.ktx.Firebase
