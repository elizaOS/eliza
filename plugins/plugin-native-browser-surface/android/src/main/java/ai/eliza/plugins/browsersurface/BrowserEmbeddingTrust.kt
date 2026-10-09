package ai.eliza.plugins.browsersurface

import android.app.Activity
import android.content.ComponentName
import android.content.pm.PackageManager
import androidx.annotation.RequiresApi

/** Matches the owned Chromium route, including Android's independently parsed alias. */
internal object BrowserEmbeddingTrust {
    val activities = listOf(
        "com.google.android.apps.chrome.IntentDispatcher",
        "org.chromium.chrome.browser.document.ChromeLauncherActivity",
        "org.chromium.chrome.browser.customtabs.CustomTabActivity",
        "org.chromium.chrome.browser.ChromeTabbedActivity"
    )

    fun requireCertificates(certificates: List<Set<String>>, hostHasCertificate: (ByteArray) -> Boolean) {
        val valid = certificates.size == activities.size && certificates.all { allowed ->
            allowed.any { digest ->
                digest.matches(Regex("[0-9a-fA-F]{64}")) &&
                    hostHasCertificate(digest.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
            }
        }
        if (!valid) throw BrowserLaunchException("BROWSER_DOCK_UNTRUSTED", "The installed browser does not allow this app to share its window. Repair the provisioned browser and try again.")
    }

    @RequiresApi(33)
    fun requireInstalledTrust(activity: Activity) {
        val manager = activity.packageManager
        val certificates: List<Set<String>> = try {
            activities.map { name ->
                val info = manager.getActivityInfo(ComponentName(ChromiumBrowserLauncher.PACKAGE_NAME, name), 0)
                if (!info.enabled) emptySet() else info.knownActivityEmbeddingCerts
            }
        } catch (error: PackageManager.NameNotFoundException) {
            // error-policy:J3 Missing browser routes cannot satisfy the embedding contract.
            throw BrowserLaunchException("BROWSER_DOCK_UNTRUSTED", "The installed browser does not provide the required shared-window activities.")
        }
        requireCertificates(certificates) { digest ->
            manager.hasSigningCertificate(activity.packageName, digest, PackageManager.CERT_INPUT_SHA256)
        }
    }
}
