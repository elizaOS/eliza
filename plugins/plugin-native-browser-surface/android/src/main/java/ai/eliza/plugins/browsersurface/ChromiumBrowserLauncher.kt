/**
 * Opens ordinary websites in the installed full Chromium browser, using its
 * own cookies, permissions, user agent and credential providers. Custom Tabs
 * retain browser origin chrome; they are not isolated Eliza WebView surfaces.
 */
package ai.eliza.plugins.browsersurface

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsService
import java.net.URI

class BrowserLaunchException(val code: String, message: String) : IllegalArgumentException(message)

object ChromiumBrowserLauncher {
    const val PACKAGE_NAME = BuildConfig.ELIZA_CHROMIUM_PACKAGE_NAME

    internal fun validatedUrl(value: String): String {
        val parsed = try {
            URI(value)
        } catch (error: java.net.URISyntaxException) {
            // error-policy:J3 Reject malformed input before sending any browser intent.
            throw BrowserLaunchException("INVALID_BROWSER_URL", "Enter a complete http or https website address.")
        }
        if ((parsed.scheme != "https" && parsed.scheme != "http") ||
            parsed.host.isNullOrBlank() || parsed.rawUserInfo != null ||
            parsed.port < -1 || parsed.port > 65535) {
            throw BrowserLaunchException("INVALID_BROWSER_URL", "Enter a complete http or https website address without embedded credentials.")
        }
        return parsed.toASCIIString()
    }

    /** Present the pinned browser without navigating or creating a website tab. */
    @JvmStatic
    fun present(activity: Activity) {
        requireTrustedBrowser(activity)
        val intent = activity.packageManager.getLaunchIntentForPackage(PACKAGE_NAME)
            ?: throw BrowserLaunchException("BROWSER_UNAVAILABLE", "The configured browser has no launchable activity.")
        if (intent.component?.packageName != PACKAGE_NAME) {
            throw BrowserLaunchException("BROWSER_UNTRUSTED", "The browser activity does not match provisioning.")
        }
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        activity.startActivity(intent)
    }

    /**
     * Whether the build's pinned Chromium package is installed with its pinned
     * signing certificate. Uses the same check as [launch] and [present], so
     * apps can decide whether to offer a browser flow before starting it.
     */
    @JvmStatic
    fun isTrusted(context: Context): Boolean =
        isTrusted(Build.VERSION.SDK_INT, BuildConfig.ELIZA_CHROMIUM_CERT_SHA256) { packageName, certificate ->
            context.packageManager.hasSigningCertificate(packageName, certificate, PackageManager.CERT_INPUT_SHA256)
        }

    internal fun isTrusted(sdkInt: Int, certificateSha256: String, lookup: ChromiumBrowserIdentity.SigningCertificateLookup): Boolean =
        sdkInt >= Build.VERSION_CODES.P &&
            ChromiumBrowserIdentity.isTrustedPackage(PACKAGE_NAME, certificateSha256, lookup)

    /**
     * Whether the pinned Chromium package answers Custom Tabs connections.
     * This does not check the signer; pair it with [isTrusted].
     */
    @JvmStatic
    fun supportsCustomTabs(context: Context): Boolean {
        val service = Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION).setPackage(PACKAGE_NAME)
        return context.packageManager.resolveService(service, 0) != null
    }

    internal fun requireTrustedBrowser(activity: Activity) {
        if (!isTrusted(activity)) {
            throw BrowserLaunchException("BROWSER_UNTRUSTED", "The configured Chromium package or signing certificate is unavailable. Repair the provisioned browser and try again.")
        }
    }

    @JvmStatic
    fun launch(activity: Activity, url: String) {
        val target = Uri.parse(validatedUrl(url))
        requireTrustedBrowser(activity)
        if (!supportsCustomTabs(activity)) {
            throw BrowserLaunchException("BROWSER_UNAVAILABLE", "Chromium is unavailable. Install or repair the system Chromium browser, then try again.")
        }
        val browser = CustomTabsIntent.Builder().setShowTitle(true).build()
        browser.intent.setPackage(PACKAGE_NAME)
        browser.intent.data = target
        if (activity.packageManager.resolveActivity(browser.intent, PackageManager.MATCH_DEFAULT_ONLY) == null) {
            throw BrowserLaunchException("BROWSER_UNAVAILABLE", "Chromium cannot open websites. Enable or repair the system browser, then try again.")
        }
        browser.launchUrl(activity, target)
    }
}
