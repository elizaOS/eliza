package ai.eliza.plugins.websiteblocker

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ScrollView
import android.widget.TextView

class WebsiteBlockerShowcaseActivity : Activity() {
    private lateinit var textView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        WebsiteBlockerStateStore.clear(applicationContext)
        WebsiteBlockerStateStore.save(
            applicationContext,
            listOf("x.com", "news.google.com"),
            System.currentTimeMillis() + 30 * 60_000L,
        )
        val state = requireNotNull(WebsiteBlockerStateStore.load(applicationContext))

        textView = TextView(this).apply {
            textSize = 18f
            setPadding(36, 36, 36, 36)
            text = buildString {
                appendLine("Website Blocker State")
                appendLine("Package: ${applicationContext.packageName}")
                appendLine("Active: true")
                appendLine("Requested: ${state.requestedWebsites.joinToString()}")
                appendLine("Blocked count: ${state.blockedWebsites.size}")
                appendLine("Allowed count: ${state.allowedWebsites.size}")
                appendLine("Match mode: ${state.matchMode}")
                appendLine("Blocked x.com: ${WebsiteBlockerStateStore.isBlockedHostname(state, "x.com")}")
                appendLine("Blocked t.co: ${WebsiteBlockerStateStore.isBlockedHostname(state, "t.co")}")
                appendLine("Allowed api.x.com: ${WebsiteBlockerStateStore.isBlockedHostname(state, "api.x.com")}")
                appendLine("Allowed accounts.google.com: ${WebsiteBlockerStateStore.isBlockedHostname(state, "accounts.google.com")}")
            }
        }
        setContentView(
            ScrollView(this).apply {
                addView(
                    textView,
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
            },
        )
    }

    fun snapshotText(): String = textView.text.toString()
}
