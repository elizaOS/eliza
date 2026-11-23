package ai.eliza.plugins.appblocker

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * [Context]-backed reader for the launchable-app enumeration that
 * [AppBlockerPlugin.getInstalledApps] exposes — the
 * `PackageManager.queryIntentActivities(ACTION_MAIN/CATEGORY_LAUNCHER)` read.
 *
 * Extracted from the Capacitor plugin so the real [PackageManager] query can be
 * exercised by an instrumented `androidTest` without a Capacitor `Bridge`/WebView
 * (issue #9967). The plugin delegates to it and marshals each record into the
 * unchanged `{ packageName, displayName }` JS shape. Permission-free.
 */
class InstalledAppsReader(context: Context) {

    private val appContext: Context = context.applicationContext

    data class LaunchableApp(val packageName: String, val displayName: String)

    /**
     * Home-screen-launchable apps, excluding this app, de-duplicated by package
     * and sorted case-insensitively by display name.
     */
    fun listLaunchableApps(): List<LaunchableApp> {
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val pm = appContext.packageManager
        val matches = if (Build.VERSION.SDK_INT >= 33) {
            pm.queryIntentActivities(launcherIntent, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(launcherIntent, 0)
        }

        val ownPackageName = appContext.packageName
        return matches
            .asSequence()
            .mapNotNull { resolveInfo ->
                val packageName = resolveInfo.activityInfo?.packageName?.trim().orEmpty()
                if (packageName.isEmpty() || packageName == ownPackageName) {
                    return@mapNotNull null
                }
                val displayName = resolveInfo.loadLabel(pm)
                    ?.toString()
                    ?.trim()
                    .takeUnless { it.isNullOrEmpty() }
                    ?: packageName
                LaunchableApp(packageName, displayName)
            }
            .distinctBy { it.packageName }
            .sortedBy { it.displayName.lowercase() }
            .toList()
    }
}
