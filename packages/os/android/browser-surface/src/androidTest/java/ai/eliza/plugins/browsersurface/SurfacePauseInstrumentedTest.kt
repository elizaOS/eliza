/**
 * Shows a busy website WebView in a real window and checks what pauseSurface's
 * WebView.onPause() does: the page is hidden to Chromium and stops drawing, its
 * JavaScript state and history stay, and onResume() brings it back. It also logs the
 * CPU time of the page's renderer and of the app in each state (tag SurfacePause).
 */
package ai.eliza.plugins.browsersurface

import android.graphics.PixelFormat
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class SurfacePauseInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val windows = context.getSystemService(WindowManager::class.java)
    private lateinit var root: FrameLayout
    private lateinit var site: WebView

    @After
    fun close() {
        instrumentation.runOnMainSync {
            if (::root.isInitialized && root.isAttachedToWindow) windows.removeView(root)
            if (::site.isInitialized) site.destroy()
        }
    }

    private fun js(script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        instrumentation.runOnMainSync {
            site.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        assertTrue("no reply to $script", latch.await(5, TimeUnit.SECONDS))
        return result
    }

    private fun waitFor(script: String) {
        val end = SystemClock.uptimeMillis() + 15_000
        while (js(script) != "true") {
            check(SystemClock.uptimeMillis() < end) { "timed out waiting for $script" }
            SystemClock.sleep(100)
        }
    }

    private fun shell(command: String): String =
        instrumentation.uiAutomation.executeShellCommand(command).use { fd ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().readText()
        }

    private fun sandboxedPids(): Set<Int> = shell("ps -A -o PID,ARGS").lines()
        .filter { it.contains("sandboxed_process") }
        .mapNotNull { it.trim().substringBefore(' ').toIntOrNull() }
        .toSet()

    /** utime + stime of a process, in clock ticks. */
    private fun cpuTicks(pid: Int): Long? = shell("cat /proc/$pid/stat").substringAfterLast(')')
        .trim().split(' ').let { fields -> if (fields.size > 12) fields[11].toLong() + fields[12].toLong() else null }

    private fun counters(): Pair<Long, Long> {
        val (frames, ticks) = js("frames+','+ticks").trim('"').split(',')
        return frames.toLong() to ticks.toLong()
    }

    private fun measure(state: String, renderer: Int?): Pair<Long, Long> {
        SystemClock.sleep(500)
        val before = counters()
        val rendererBefore = renderer?.let(::cpuTicks)
        val appBefore = cpuTicks(Process.myPid())
        SystemClock.sleep(3_000)
        val after = counters()
        val rendererAfter = renderer?.let(::cpuTicks)
        val appAfter = cpuTicks(Process.myPid())
        val frames = after.first - before.first
        val ticks = after.second - before.second
        Log.i(TAG, "$state: frames=$frames timerTicks=$ticks rendererCpuTicks=" +
            "${if (rendererBefore != null && rendererAfter != null) rendererAfter - rendererBefore else "unknown"} " +
            "appCpuTicks=${if (appBefore != null && appAfter != null) appAfter - appBefore else "unknown"} (3 s)")
        return frames to ticks
    }

    @Test
    fun aPausedPageStopsDrawingAndKeepsItsStateAndHistory() {
        instrumentation.uiAutomation
            .executeShellCommand("appops set ${context.packageName} SYSTEM_ALERT_WINDOW allow").close()
        val existing = sandboxedPids()
        instrumentation.runOnMainSync {
            root = FrameLayout(context)
            site = WebView(context).apply { settings.javaScriptEnabled = true }
            root.addView(site, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            site.loadDataWithBaseURL("https://first.test/", "<body>first</body>", "text/html", "utf-8", "https://first.test/")
            windows.addView(
                root,
                WindowManager.LayoutParams(
                    600, 600,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    0,
                    PixelFormat.TRANSLUCENT,
                ).apply { gravity = Gravity.TOP or Gravity.START },
            )
        }
        waitFor("location.host==='first.test'&&document.readyState==='complete'")
        instrumentation.runOnMainSync {
            // A busy page: a CSS animation, a drawing loop and a 10 ms timer.
            site.loadDataWithBaseURL(
                "https://second.test/",
                "<style>@keyframes s{to{transform:rotate(1turn)}}div{width:200px;height:200px;background:#06c;" +
                    "animation:s 1s linear infinite}</style><body><div></div><canvas id=c width=300 height=300></canvas>" +
                    "<script>window.state='kept';window.frames=0;window.ticks=0;const g=c.getContext('2d');" +
                    "(function f(t){frames++;g.fillStyle='hsl('+(t%360)+',80%,50%)';g.fillRect(0,0,300,300);" +
                    "requestAnimationFrame(f)})(0);setInterval(()=>ticks++,10)</script></body>",
                "text/html", "utf-8", "https://second.test/",
            )
        }
        waitFor("location.host==='second.test'&&window.frames>10")
        val renderer = (sandboxedPids() - existing).singleOrNull()

        val visible = measure("visible", renderer)
        assertTrue("a visible page draws frames", visible.first > 30)
        assertEquals("\"visible\"", js("document.visibilityState"))

        instrumentation.runOnMainSync { root.visibility = View.GONE }
        measure("hidden (presentSurface only)", renderer)

        instrumentation.runOnMainSync { site.onPause() }
        assertEquals("\"hidden\"", js("document.visibilityState"))
        val hiddenPaused = measure("hidden and paused", renderer)
        assertEquals("a paused hidden page draws nothing", 0L, hiddenPaused.first)

        // pauseSurface does not change visibility; a shown paused page still draws nothing.
        instrumentation.runOnMainSync { root.visibility = View.VISIBLE }
        val shownPaused = measure("shown and paused", renderer)
        assertEquals("\"hidden\"", js("document.visibilityState"))
        assertEquals("a paused page draws nothing even when shown", 0L, shownPaused.first)

        assertEquals("\"kept\"", js("window.state"))
        var canGoBack = false
        instrumentation.runOnMainSync { canGoBack = site.canGoBack() }
        assertTrue("history is kept", canGoBack)

        instrumentation.runOnMainSync { site.onResume() }
        waitFor("document.visibilityState==='visible'")
        val resumed = measure("resumed", renderer)
        assertTrue("a resumed page draws again", resumed.first > 30)
        assertEquals("\"kept\"", js("window.state"))
    }

    private companion object {
        const val TAG = "SurfacePause"
    }
}
