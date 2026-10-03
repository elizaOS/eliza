package ai.eliza.plugins.browsersurface

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import androidx.window.embedding.ActivityEmbeddingController
import androidx.window.embedding.RuleController
import androidx.window.embedding.SplitAttributes
import androidx.window.embedding.SplitController
import androidx.window.embedding.SplitPairFilter
import androidx.window.embedding.SplitPairRule
import androidx.window.embedding.SplitRule
import androidx.window.layout.WindowMetricsCalculator
import com.getcapacitor.JSObject

/** Native activity bounds only; never grants task authority or emulates the website. */
internal object BrowserDockController {
    private const val TAG = "eliza-browser-dock"

    fun ratio(totalWidthDp: Float, panelWidthDp: Int): Float {
        if (!totalWidthDp.isFinite() || panelWidthDp < 320 || panelWidthDp > 640 || totalWidthDp - panelWidthDp < 480) {
            throw BrowserLaunchException("BROWSER_DOCK_SIZE_UNAVAILABLE", "The window cannot fit the requested helper and browser panes.")
        }
        return panelWidthDp / totalWidthDp
    }

    fun supported(activity: Activity): Boolean = Build.VERSION.SDK_INT >= 33 &&
        SplitController.getInstance(activity).splitSupportStatus == SplitController.SplitSupportStatus.SPLIT_AVAILABLE

    fun state(activity: Activity): JSObject {
        val bounds = WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(activity).bounds
        return JSObject().apply {
            put("supported", supported(activity))
            put("embedded", ActivityEmbeddingController.getInstance(activity).isActivityEmbedded(activity))
            put("bounds", JSObject().apply {
                put("x", bounds.left); put("y", bounds.top)
                put("width", bounds.width()); put("height", bounds.height())
            })
        }
    }

    /** Preserve the visible embedded browser instead of selecting its launcher tab. */
    fun present(activity: Activity) {
        ChromiumBrowserLauncher.requireTrustedBrowser(activity)
        if (Build.VERSION.SDK_INT >= 33 && ActivityEmbeddingController.getInstance(activity).isActivityEmbedded(activity)) {
            BrowserEmbeddingTrust.requireInstalledTrust(activity)
            return
        }
        ChromiumBrowserLauncher.present(activity)
    }

    fun open(activity: Activity, url: String, panelWidthDp: Int) {
        ChromiumBrowserLauncher.validatedUrl(url)
        ChromiumBrowserLauncher.requireTrustedBrowser(activity)
        if (android.os.Build.VERSION.SDK_INT < 33 || !supported(activity)) throw BrowserLaunchException("BROWSER_DOCK_UNAVAILABLE", "Activity embedding is unavailable on this host.")
        BrowserEmbeddingTrust.requireInstalledTrust(activity)
        val metrics = WindowMetricsCalculator.getOrCreate().computeMaximumWindowMetrics(activity)
        val widthDp = metrics.bounds.width() / activity.resources.displayMetrics.density
        val attributes = SplitAttributes.Builder()
            .setSplitType(SplitAttributes.SplitType.ratio(ratio(widthDp, panelWidthDp)))
            .setLayoutDirection(SplitAttributes.LayoutDirection.RIGHT_TO_LEFT)
            .build()
        // Custom Tabs dispatch starts with a package-scoped implicit VIEW intent.
        // Exact final-activity filters cannot match it in the host process. Keep
        // the package exact; Android separately enforces each activity's opt-in.
        val filters = setOf(
            SplitPairFilter(activity.componentName, ComponentName(ChromiumBrowserLauncher.PACKAGE_NAME, "*"), Intent.ACTION_VIEW)
        )
        val rule = SplitPairRule.Builder(filters)
            .setTag(TAG).setMinWidthDp(panelWidthDp + 480).setMinSmallestWidthDp(0)
            .setDefaultSplitAttributes(attributes)
            .setFinishPrimaryWithSecondary(SplitRule.FinishBehavior.NEVER)
            .setFinishSecondaryWithPrimary(SplitRule.FinishBehavior.NEVER)
            .setClearTop(false).build()
        val controller = RuleController.getInstance(activity)
        controller.getRules().filter { it.tag == TAG }.forEach { controller.removeRule(it) }
        controller.addRule(rule)
        try {
            // Explicit navigation; dispatch alone does not prove a split or select a task tab.
            ChromiumBrowserLauncher.launch(activity, url)
        } catch (error: RuntimeException) {
            // error-policy:J1 Restore host rules when Android rejects the launch.
            controller.removeRule(rule)
            throw error
        }
    }
}
