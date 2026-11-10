/**
 * Proves with real Android views that a below-host page sits under the host, is drawn
 * without holes, and receives exactly the gestures that start on it.
 */
package ai.eliza.plugins.browsersurface

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BelowHostLayerInstrumentedTest {
    /** Consumes every event, like a WebView, and records it with its newest finger. */
    private class Recorder(context: Context) : View(context) {
        val events = ArrayList<String>()
        private fun record(event: MotionEvent): Boolean {
            val last = event.pointerCount - 1
            events += "${MotionEvent.actionToString(event.action)}@${event.getX(last).toInt()},${event.getY(last).toInt()}"
            return true
        }
        override fun dispatchTouchEvent(event: MotionEvent) = record(event)
        override fun dispatchGenericMotionEvent(event: MotionEvent) = record(event)
    }

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val host = FrameLayout(context)
    private val hostWebView = Recorder(context)
    private val website = Recorder(context)
    private val page = OccludingSurfaceLayout(context, SurfaceLayer.BELOW_HOST)
    private val live = mutableListOf(page)
    private val router = BelowHostInputRouter(context) { live.toList() }

    init {
        host.addView(hostWebView, FrameLayout.LayoutParams(300, 300))
        page.addView(website, FrameLayout.LayoutParams(100, 100))
        host.addView(
            page,
            surfaceInsertIndex(SurfaceLayer.BELOW_HOST, host.indexOfChild(hostWebView)),
            FrameLayout.LayoutParams(100, 100).apply {
                leftMargin = 50
                topMargin = 50
            },
        )
        host.addView(router, host.indexOfChild(hostWebView) + 1, FrameLayout.LayoutParams(300, 300))
        // Page rect (50,50)-(150,150) in host pixels; the host owns (110,50)-(150,90).
        page.setOuterClip(RoundedOuterClip(0f, 0f, 100f, 100f, 20f, 20f, 20f, 20f))
        page.setOcclusions(listOf(RoundedOcclusionRect(60f, 0f, 100f, 40f, 0f)))
        page.hostRectsReceived = true
        val exact = View.MeasureSpec.makeMeasureSpec(300, View.MeasureSpec.EXACTLY)
        host.measure(exact, exact)
        host.layout(0, 0, 300, 300)
    }

    private fun touch(action: Int, x: Float, y: Float, downTime: Long = 0): Boolean {
        val event = MotionEvent.obtain(downTime, downTime + 1, action, x, y, 0)
        try {
            return host.dispatchTouchEvent(event)
        } finally {
            event.recycle()
        }
    }

    /** A two-finger event: finger 0 at [first], finger 1 at [second]. */
    private fun twoFingers(action: Int, first: Pair<Float, Float>, second: Pair<Float, Float>, downTime: Long) {
        val properties = Array(2) { id -> MotionEvent.PointerProperties().apply { this.id = id; toolType = MotionEvent.TOOL_TYPE_FINGER } }
        val coords = arrayOf(first, second).map { (x, y) -> MotionEvent.PointerCoords().apply { this.x = x; this.y = y } }.toTypedArray()
        val event = MotionEvent.obtain(downTime, downTime + 2, action, 2, properties, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
        try {
            host.dispatchTouchEvent(event)
        } finally {
            event.recycle()
        }
    }

    private fun mouse(action: Int, x: Float, y: Float) {
        val event = MotionEvent.obtain(0, 0, action, x, y, 0).apply { source = InputDevice.SOURCE_MOUSE }
        try {
            host.dispatchGenericMotionEvent(event)
        } finally {
            event.recycle()
        }
    }

    @Test
    fun theSurfaceIsInsertedBelowTheHostAndTheRouterJustAboveIt() {
        assertEquals(listOf<View>(page, hostWebView, router), (0 until host.childCount).map(host::getChildAt))
        val nested = FrameLayout(context)
        val branch = LinearLayout(context)
        val webView = View(context)
        nested.addView(branch)
        branch.addView(webView)
        assertSame(branch, hostBranch(nested, webView))
        assertNull(hostBranch(FrameLayout(context), webView))
    }

    @Test
    fun aTapOnThePageReachesTheWebsiteInItsOwnCoordinates() {
        assertTrue(touch(MotionEvent.ACTION_DOWN, 70f, 70f))
        touch(MotionEvent.ACTION_UP, 70f, 70f)
        assertEquals(listOf("ACTION_DOWN@20,20", "ACTION_UP@20,20"), website.events)
        assertEquals(emptyList<String>(), hostWebView.events)
    }

    @Test
    fun tapsOnHostRectsAndOutsideThePageStayWithTheHost() {
        touch(MotionEvent.ACTION_DOWN, 130f, 60f, downTime = 1)
        touch(MotionEvent.ACTION_UP, 130f, 60f, downTime = 1)
        touch(MotionEvent.ACTION_DOWN, 10f, 10f, downTime = 5)
        touch(MotionEvent.ACTION_UP, 10f, 10f, downTime = 5)
        // The page's rounded corner is host chrome too.
        touch(MotionEvent.ACTION_DOWN, 51f, 51f, downTime = 9)
        assertEquals(emptyList<String>(), website.events)
        assertEquals(5, hostWebView.events.size)
    }

    @Test
    fun aGestureThatStartsOnThePageStaysThereUntilItEnds() {
        touch(MotionEvent.ACTION_DOWN, 70f, 120f)
        touch(MotionEvent.ACTION_MOVE, 130f, 60f)
        touch(MotionEvent.ACTION_MOVE, 250f, 250f)
        touch(MotionEvent.ACTION_CANCEL, 250f, 250f)
        assertEquals(listOf("ACTION_DOWN@20,70", "ACTION_MOVE@80,10", "ACTION_MOVE@200,200", "ACTION_CANCEL@200,200"), website.events)
        assertEquals(emptyList<String>(), hostWebView.events)
    }

    @Test
    fun aSecondFingerJoinsTheGestureOfTheFirst() {
        touch(MotionEvent.ACTION_DOWN, 70f, 120f, downTime = 10)
        twoFingers(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 70f to 120f, 130f to 60f, 10)
        touch(MotionEvent.ACTION_CANCEL, 70f, 120f, downTime = 10)
        assertEquals(listOf("ACTION_DOWN@20,70", "ACTION_POINTER_DOWN(1)@80,10", "ACTION_CANCEL@20,70"), website.events)
        assertEquals(emptyList<String>(), hostWebView.events)

        // A finger that lands on the page during a host gesture stays with the host.
        touch(MotionEvent.ACTION_DOWN, 130f, 60f, downTime = 20)
        twoFingers(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 130f to 60f, 70f to 120f, 20)
        assertEquals(3, website.events.size)
        assertEquals(listOf("ACTION_DOWN@130,60", "ACTION_POINTER_DOWN(1)@70,120"), hostWebView.events)
    }

    @Test
    fun aHiddenPageTakesNoInput() {
        page.visibility = View.GONE
        touch(MotionEvent.ACTION_DOWN, 70f, 70f)
        assertEquals(emptyList<String>(), website.events)
        assertEquals(1, hostWebView.events.size)
    }

    @Test
    fun aPageTakesNoInputUntilTheHostSendsItsRects() {
        page.hostRectsReceived = false
        touch(MotionEvent.ACTION_DOWN, 70f, 70f, downTime = 1)
        touch(MotionEvent.ACTION_UP, 70f, 70f, downTime = 1)
        mouse(MotionEvent.ACTION_HOVER_MOVE, 70f, 70f)
        assertEquals(emptyList<String>(), website.events)
        assertEquals(
            listOf("ACTION_DOWN@70,70", "ACTION_UP@70,70", "ACTION_HOVER_ENTER@70,70", "ACTION_HOVER_MOVE@70,70"),
            hostWebView.events,
        )
        page.hostRectsReceived = true
        touch(MotionEvent.ACTION_DOWN, 70f, 70f, downTime = 2)
        assertEquals(listOf("ACTION_DOWN@20,20"), website.events)
    }

    @Test
    fun aPageHiddenMidGestureIsCancelledAndGetsNoClick() {
        touch(MotionEvent.ACTION_DOWN, 70f, 70f, downTime = 1)
        page.visibility = View.GONE
        touch(MotionEvent.ACTION_MOVE, 72f, 72f, downTime = 1)
        touch(MotionEvent.ACTION_UP, 72f, 72f, downTime = 1)
        assertEquals(listOf("ACTION_DOWN@20,20", "ACTION_CANCEL@22,22"), website.events)
        // The rest of the gesture is swallowed: the host never sees half a gesture.
        assertEquals(emptyList<String>(), hostWebView.events)
        // The next gesture is the host's.
        touch(MotionEvent.ACTION_DOWN, 70f, 70f, downTime = 2)
        assertEquals(listOf("ACTION_DOWN@70,70"), hostWebView.events)
    }

    @Test
    fun aPageNoLongerForegroundedMidGestureIsCancelled() {
        touch(MotionEvent.ACTION_DOWN, 70f, 70f, downTime = 1)
        live.clear()
        touch(MotionEvent.ACTION_UP, 70f, 70f, downTime = 1)
        assertEquals(listOf("ACTION_DOWN@20,20", "ACTION_CANCEL@20,20"), website.events)
        assertEquals(emptyList<String>(), hostWebView.events)
    }

    @Test
    fun aHoveredPageThatIsHiddenGetsAnExit() {
        mouse(MotionEvent.ACTION_HOVER_MOVE, 70f, 70f)
        page.visibility = View.GONE
        mouse(MotionEvent.ACTION_HOVER_MOVE, 72f, 72f)
        assertEquals(listOf("ACTION_HOVER_ENTER@20,20", "ACTION_HOVER_MOVE@20,20", "ACTION_HOVER_EXIT@22,22"), website.events)
    }

    @Test
    fun hoverAndMouseWheelFollowThePointer() {
        mouse(MotionEvent.ACTION_HOVER_ENTER, 70f, 70f)
        mouse(MotionEvent.ACTION_HOVER_MOVE, 80f, 80f)
        mouse(MotionEvent.ACTION_SCROLL, 80f, 80f)
        mouse(MotionEvent.ACTION_HOVER_MOVE, 130f, 60f)
        mouse(MotionEvent.ACTION_SCROLL, 130f, 60f)
        assertEquals(
            listOf("ACTION_HOVER_ENTER@20,20", "ACTION_HOVER_MOVE@30,30", "ACTION_SCROLL@30,30", "ACTION_HOVER_EXIT@80,10"),
            website.events,
        )
        assertEquals(listOf("ACTION_HOVER_ENTER@130,60", "ACTION_HOVER_MOVE@130,60", "ACTION_SCROLL@130,60"), hostWebView.events)
    }

    @Test
    fun theBelowHostPageIsClippedToItsRectangleWithNoHoles() {
        val surface = OccludingSurfaceLayout(context, SurfaceLayer.BELOW_HOST)
        surface.addView(View(context).apply { setBackgroundColor(Color.RED) }, FrameLayout.LayoutParams(100, 100))
        surface.setOuterClip(RoundedOuterClip(0f, 0f, 90f, 100f, 20f, 20f, 20f, 20f))
        surface.setOcclusions(listOf(RoundedOcclusionRect(20f, 20f, 80f, 80f, 20f)))
        val exact = View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY)
        surface.measure(exact, exact)
        surface.layout(0, 0, 100, 100)
        val bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        surface.draw(Canvas(bitmap))

        assertEquals(Color.RED, bitmap.getPixel(0, 0))
        assertEquals(Color.RED, bitmap.getPixel(50, 50))
        assertEquals(Color.TRANSPARENT, bitmap.getPixel(95, 50))

        // Captures still paint over host-owned rects and the rounded corners.
        val capture = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        surface.maskHostRegions(Canvas(capture))
        assertTrue(capture.getPixel(50, 50) != Color.TRANSPARENT)
        assertTrue(capture.getPixel(0, 0) != Color.TRANSPARENT)
        assertEquals(Color.TRANSPARENT, capture.getPixel(10, 50))
    }

    @Test
    fun newHostRectsMoveBelowHostInputWithoutARedraw() {
        fun drawnLayout(layer: SurfaceLayer) = OccludingSurfaceLayout(context, layer).apply {
            addView(View(context), FrameLayout.LayoutParams(100, 100))
            hostRectsReceived = true
            val exact = View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY)
            measure(exact, exact)
            layout(0, 0, 100, 100)
            draw(Canvas(Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)))
        }
        val moved = listOf(RoundedOcclusionRect(0f, 0f, 40f, 40f, 0f))

        // Above-host occlusions are holes in the drawing, so new ones redraw the page.
        val above = drawnLayout(SurfaceLayer.ABOVE_HOST)
        assertFalse(above.isDirty)
        above.setOcclusions(moved)
        assertTrue(above.isDirty)

        // Below the host they only route input (and mask captures), so nothing is redrawn.
        val below = drawnLayout(SurfaceLayer.BELOW_HOST)
        assertTrue(below.pageOwns(20f, 20f))
        below.setOcclusions(moved)
        assertFalse(below.isDirty)
        assertFalse(below.pageOwns(20f, 20f))
        assertTrue(below.pageOwns(60f, 60f))
    }

    /** A surface as the plugin would add it: appended when above-host, at the branch's index when below-host. */
    private fun add(into: FrameLayout, branch: View, layer: SurfaceLayer): OccludingSurfaceLayout =
        OccludingSurfaceLayout(context, layer).also {
            into.addView(it, surfaceInsertIndex(layer, into.indexOfChild(branch)), FrameLayout.LayoutParams(10, 10))
        }

    @Test
    fun mixedLayersKeepTheRouterDirectlyAboveTheHostAndAboveHostPagesOnTop() {
        val root = FrameLayout(context)
        val branch = View(context)
        val other = BelowHostInputRouter(context) { emptyList() }
        root.addView(branch)
        fun order() = (0 until root.childCount).map(root::getChildAt)

        val a = add(root, branch, SurfaceLayer.BELOW_HOST)
        placeRouter(root, branch, other)
        assertEquals(listOf<View>(a, branch, other), order())
        val b = add(root, branch, SurfaceLayer.ABOVE_HOST)
        assertEquals(listOf<View>(a, branch, other, b), order())
        val c = add(root, branch, SurfaceLayer.BELOW_HOST)
        placeRouter(root, branch, other)
        assertEquals(listOf<View>(a, c, branch, other, b), order())

        raiseSurface(root, a, branch) { other }
        assertEquals(listOf<View>(a, c, branch, other, b), order())
        val d = add(root, branch, SurfaceLayer.ABOVE_HOST)
        raiseSurface(root, b, branch) { other }
        assertEquals(listOf<View>(a, c, branch, other, d, b), order())
        // An above-host page is still brought to the front over the router.
        raiseSurface(root, d, branch) { other }
        assertEquals(listOf<View>(a, c, branch, other, b, d), order())

        // A router that drifted (another view added above the host) is put back.
        val stray = View(context)
        root.addView(stray, root.indexOfChild(branch) + 1)
        raiseSurface(root, c, branch) { other }
        assertEquals(listOf<View>(a, c, branch, other, stray, b, d), order())
    }
}
