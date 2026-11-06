/**
 * Puts a website WebView below a transparent host WebView in a real window and taps
 * the screen: the page shows through the host, a tap on the page reaches and focuses
 * the website, and a tap on host chrome reaches only the host.
 */
package ai.eliza.plugins.browsersurface

import android.content.ClipData
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.SystemClock
import android.view.Gravity
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
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
    private lateinit var page: OccludingSurfaceLayout

    /** Drags the drag source started; touched only on the main thread. */
    private var dragsStarted = 0

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
            page = OccludingSurfaceLayout(context, SurfaceLayer.BELOW_HOST)
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
            page.hostRectsReceived = true
            // A drag source outside the page: a press on it starts a text drag.
            root.addView(
                android.view.View(context).apply {
                    setBackgroundColor(Color.YELLOW)
                    setOnTouchListener { view, event ->
                        if (event.actionMasked == MotionEvent.ACTION_DOWN &&
                            view.startDragAndDrop(ClipData.newPlainText("text", "dropped"), android.view.View.DragShadowBuilder(view), null, 0)
                        ) {
                            dragsStarted++
                        }
                        true
                    }
                },
                FrameLayout.LayoutParams(80, 80).apply {
                    leftMargin = 0
                    topMargin = 520
                },
            )
            val counter = "<script>window.taps=0;window.moves=0;window.drops=0;addEventListener('pointerdown',()=>taps++);" +
                "addEventListener('pointermove',()=>moves++);addEventListener('dragover',e=>e.preventDefault());" +
                "addEventListener('drop',()=>drops++)</script>"
            site.loadDataWithBaseURL(
                "https://site.test/",
                "<body style='margin:0;background:#f00'><input id='field' style='width:100%;height:50vh'>$counter</body>",
                "text/html", "utf-8", null,
            )
            val cssPx = { px: Int -> px / density }
            host.loadDataWithBaseURL(
                "https://host.test/",
                "<body style='margin:0;background:transparent'><div style='position:absolute;" +
                    "left:${cssPx(400)}px;top:${cssPx(100)}px;width:${cssPx(100)}px;height:${cssPx(100)}px;background:#00f'></div>" +
                    "<div style='position:absolute;left:${cssPx(120)}px;top:${cssPx(420)}px;width:${cssPx(50)}px;" +
                    "height:${cssPx(50)}px;background:#0f0'></div>$counter</body>",
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
        // Both WebViews draw a few frames after load, so wait for the expected screen.
        val expected = listOf(Triple(300, 450, Color.RED), Triple(450, 150, Color.BLUE), Triple(145, 445, Color.GREEN))
        var seen = emptyList<Int>()
        val end = SystemClock.uptimeMillis() + 10_000
        while (seen != expected.map { it.third }) {
            check(SystemClock.uptimeMillis() < end) { "screen pixels were $seen" }
            val screen = instrumentation.uiAutomation.takeScreenshot()
            seen = expected.map { (x, y) -> screen.getPixel(origin[0] + x, origin[1] + y) or 0xFF000000.toInt() }
            screen.recycle()
            if (seen != expected.map { it.third }) SystemClock.sleep(200)
        }

        // A capture draws the page alone: the host overlay is not in it, and host rects are masked.
        var capture: android.graphics.Bitmap? = null
        instrumentation.runOnMainSync {
            capture = drawPageForCapture(page).also { page.maskHostRegions(android.graphics.Canvas(it)) }
        }
        val image = capture!!
        assertEquals(Color.RED, image.getPixel(45, 345))
        assertEquals(Color.RED, image.getPixel(200, 350))
        assertEquals(0xFF5F6368.toInt(), image.getPixel(350, 50))
        image.recycle()

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

        // A text drag dropped on the page's input lands in the website, not the host.
        drag(to = 200 to 150)
        assertEquals("\"dropped\"", js(site, "document.getElementById('field').value"))
        assertEquals("1", js(site, "drops"))
        assertEquals("0", js(host, "drops"))
        // One dropped on a host-owned rect over the page lands in the host.
        drag(to = 450 to 150)
        assertEquals("1", js(site, "drops"))
        assertEquals("1", js(host, "drops"))
    }

    /**
     * Closes the soft keyboard the focused page input opened and waits until it is gone.
     * On a short screen it covers the drag source, so the press would reach the keyboard.
     */
    private fun hideKeyboard() {
        val keyboard = context.getSystemService(InputMethodManager::class.java)
        instrumentation.runOnMainSync { keyboard.hideSoftInputFromWindow(root.windowToken, 0) }
        val end = SystemClock.uptimeMillis() + 5_000
        while (true) {
            var shown = true
            instrumentation.runOnMainSync { shown = root.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) != false }
            if (!shown) break
            check(SystemClock.uptimeMillis() < end) { "the soft keyboard did not close" }
            SystemClock.sleep(100)
        }
        instrumentation.waitForIdleSync()
        SystemClock.sleep(300)
    }

    /** Presses the drag source, moves to [to] in window pixels and lifts. */
    private fun drag(to: Pair<Int, Int>) {
        hideKeyboard()
        val origin = IntArray(2)
        instrumentation.runOnMainSync { root.getLocationOnScreen(origin) }
        var startedBefore = 0
        instrumentation.runOnMainSync { startedBefore = dragsStarted }
        val down = SystemClock.uptimeMillis()
        fun send(action: Int, x: Int, y: Int) {
            val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, (origin[0] + x).toFloat(), (origin[1] + y).toFloat(), 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true))
            event.recycle()
        }
        send(MotionEvent.ACTION_DOWN, 40, 560)
        SystemClock.sleep(500)
        var started = 0
        instrumentation.runOnMainSync { started = dragsStarted }
        assertEquals("the press on the drag source started a drag", startedBefore + 1, started)
        for (step in 1..10) {
            send(MotionEvent.ACTION_MOVE, 40 + (to.first - 40) * step / 10, 560 + (to.second - 560) * step / 10)
            SystemClock.sleep(50)
        }
        SystemClock.sleep(300)
        send(MotionEvent.ACTION_UP, to.first, to.second)
        instrumentation.waitForIdleSync()
        SystemClock.sleep(800)
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
