/**
 * Puts a website WebView below a transparent host WebView in a real window and taps
 * the screen: the page shows through the host, a tap on the page reaches and focuses
 * the website, and a tap on host chrome reaches only the host.
 */
package ai.eliza.plugins.browsersurface

import android.graphics.Color
import android.graphics.PixelFormat
import android.os.SystemClock
import android.view.Gravity
import android.view.InputDevice
import android.view.MotionEvent
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
class BelowHostWebViewInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val windows = context.getSystemService(WindowManager::class.java)
    private lateinit var root: FrameLayout
    private lateinit var site: WebView
    private lateinit var host: WebView

    @After
    fun close() {
        instrumentation.runOnMainSync {
            if (::root.isInitialized && root.isAttachedToWindow) windows.removeView(root)
            if (::site.isInitialized) site.destroy()
            if (::host.isInitialized) host.destroy()
        }
    }

    private fun js(view: WebView, script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        instrumentation.runOnMainSync {
            view.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    private fun waitFor(view: WebView, script: String) {
        val end = SystemClock.uptimeMillis() + 15_000
        while (js(view, script) != "true") {
            check(SystemClock.uptimeMillis() < end) { "timed out waiting for $script" }
            SystemClock.sleep(100)
        }
    }

    private fun tap(x: Int, y: Int) {
        val origin = IntArray(2)
        instrumentation.runOnMainSync { root.getLocationOnScreen(origin) }
        val down = SystemClock.uptimeMillis()
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, (origin[0] + x).toFloat(), (origin[1] + y).toFloat(), 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true))
            event.recycle()
        }
        instrumentation.waitForIdleSync()
        SystemClock.sleep(300)
    }

    @Test
    fun theWebsiteBelowATransparentHostGetsItsOwnTapsAndFocus() {
        instrumentation.uiAutomation
            .executeShellCommand("appops set ${context.packageName} SYSTEM_ALERT_WINDOW allow").close()
        val density = context.resources.displayMetrics.density
        // Host pixels: the page is (100,100)-(500,500); the host owns (400,100)-(500,200) over it.
        instrumentation.runOnMainSync {
            root = FrameLayout(context)
            host = WebView(context).apply {
                settings.javaScriptEnabled = true
                setBackgroundColor(Color.TRANSPARENT)
            }
            root.addView(host, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            val page = OccludingSurfaceLayout(context, SurfaceLayer.BELOW_HOST)
            site = WebView(context).apply { settings.javaScriptEnabled = true }
            page.addView(site, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            root.addView(
                page,
                surfaceInsertIndex(SurfaceLayer.BELOW_HOST, root.indexOfChild(host)),
                FrameLayout.LayoutParams(400, 400).apply {
                    leftMargin = 100
                    topMargin = 100
                },
            )
            root.addView(
                BelowHostInputRouter(context) { listOf(page) },
                root.indexOfChild(host) + 1,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            page.setOuterClip(RoundedOuterClip(0f, 0f, 400f, 400f, 0f, 0f, 0f, 0f))
            page.setOcclusions(listOf(RoundedOcclusionRect(300f, 0f, 400f, 100f, 0f)))
            val counter = "<script>window.taps=0;window.moves=0;addEventListener('pointerdown',()=>taps++);addEventListener('pointermove',()=>moves++)</script>"
            site.loadDataWithBaseURL(
                "https://site.test/",
                "<body style='margin:0;background:#f00'><input id='field' style='width:100%;height:50vh'>$counter</body>",
                "text/html", "utf-8", null,
            )
            val cssPx = { px: Int -> px / density }
            host.loadDataWithBaseURL(
                "https://host.test/",
                "<body style='margin:0;background:transparent'><div style='position:absolute;" +
                    "left:${cssPx(400)}px;top:${cssPx(100)}px;width:${cssPx(100)}px;height:${cssPx(100)}px;background:#00f'></div>$counter</body>",
                "text/html", "utf-8", null,
            )
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
        waitFor(site, "document.readyState==='complete'&&window.taps===0")
        waitFor(host, "document.readyState==='complete'&&window.taps===0")
        SystemClock.sleep(500)

        // The page shows through the transparent host, and host chrome draws over it.
        val origin = IntArray(2)
        instrumentation.runOnMainSync { root.getLocationOnScreen(origin) }
        val screen = instrumentation.uiAutomation.takeScreenshot()
        assertEquals(Color.RED, screen.getPixel(origin[0] + 300, origin[1] + 450) or 0xFF000000.toInt())
        assertEquals(Color.BLUE, screen.getPixel(origin[0] + 450, origin[1] + 150) or 0xFF000000.toInt())
        screen.recycle()

        tap(200, 150)
        assertEquals("1", js(site, "taps"))
        assertEquals("0", js(host, "taps"))
        assertEquals("\"field\"", js(site, "document.activeElement.id"))
        var focused = false
        instrumentation.runOnMainSync { focused = site.hasFocus() }
        assertTrue(focused)

        tap(450, 150)
        tap(50, 50)
        assertEquals("1", js(site, "taps"))
        assertEquals("2", js(host, "taps"))

        // A hover over the page moves over the website, not the host.
        hover(250, 400)
        hover(260, 410)
        assertTrue(js(site, "moves").toInt() > 0)
        assertEquals("0", js(host, "moves"))
    }

    private fun hover(x: Int, y: Int) {
        val origin = IntArray(2)
        instrumentation.runOnMainSync { root.getLocationOnScreen(origin) }
        val now = SystemClock.uptimeMillis()
        val event = MotionEvent.obtain(now, now, MotionEvent.ACTION_HOVER_MOVE, (origin[0] + x).toFloat(), (origin[1] + y).toFloat(), 0)
        event.source = InputDevice.SOURCE_MOUSE
        assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true))
        event.recycle()
        instrumentation.waitForIdleSync()
        SystemClock.sleep(300)
    }
}
