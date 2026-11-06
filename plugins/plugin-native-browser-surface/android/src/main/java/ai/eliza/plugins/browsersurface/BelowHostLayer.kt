/**
 * The `below-host` layer: the website is drawn under a transparent host WebView, so the
 * host paints its own chrome (with anti-aliased edges and shadows) over the page and no
 * hole is cut in the website. The host WebView consumes every touch it receives, so
 * [BelowHostInputRouter] sits just above it and sends each gesture that starts on the
 * page, outside every host-owned rect, to the website for the whole gesture.
 */
package ai.eliza.plugins.browsersurface

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup

internal enum class SurfaceLayer(val wire: String) {
    ABOVE_HOST("above-host"),
    BELOW_HOST("below-host"),
    ;

    companion object {
        /** No value is `above-host`; an unknown value is null and must be rejected. */
        fun parse(value: String?): SurfaceLayer? =
            if (value == null) ABOVE_HOST else entries.firstOrNull { it.wire == value }
    }
}

/**
 * True when a point in the surface's own pixels belongs to the website: inside the
 * surface, inside its outer clip, and outside every host-owned rect.
 */
internal fun pageOwnsPoint(
    x: Float,
    y: Float,
    width: Int,
    height: Int,
    outerClip: RoundedOuterClip?,
    hostRects: List<RoundedOcclusionRect>,
): Boolean =
    x >= 0f && y >= 0f && x < width && y < height &&
        outerClip?.contains(x, y) != false &&
        hostRects.none { it.contains(x, y) }

/**
 * Child index for a new surface container: appended (drawn above the host) for
 * `above-host`, or at the host WebView's own index (drawn below it) for `below-host`.
 */
internal fun surfaceInsertIndex(layer: SurfaceLayer, hostBranchIndex: Int): Int =
    when (layer) {
        SurfaceLayer.ABOVE_HOST -> -1
        SurfaceLayer.BELOW_HOST -> hostBranchIndex
    }

/** The direct child of [host] that holds [view], or null when [view] is not inside it. */
internal fun hostBranch(host: ViewGroup, view: View): View? {
    var current: View = view
    while (true) {
        val parent = current.parent ?: return null
        if (parent === host) return current
        current = parent as? View ?: return null
    }
}

/**
 * An empty, never-drawn view placed just above the host WebView. It claims a touch or
 * hover that starts where a visible below-host page owns the point and forwards it to that
 * page; every other event falls through to the host WebView. The host never sees a routed
 * gesture, and the page never sees one that started on host chrome, including later
 * fingers of the same gesture.
 */
internal class BelowHostInputRouter(
    context: Context,
    private val pages: () -> List<OccludingSurfaceLayout>,
) : View(context) {
    private var touchTarget: OccludingSurfaceLayout? = null
    private var hoverTarget: OccludingSurfaceLayout? = null

    /** Down time of the last gesture left to the host; its later split fingers stay there. */
    private var hostDownTime = Long.MIN_VALUE

    init {
        setWillNotDraw(true)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    /** The topmost visible page under a point in this view's coordinates. */
    private fun pageAt(x: Float, y: Float): OccludingSurfaceLayout? {
        val parent = parent as? ViewGroup ?: return null
        return pages()
            .filter { it.parent === parent && it.visibility == VISIBLE }
            .sortedByDescending { parent.indexOfChild(it) }
            .firstOrNull { page ->
                page.pageOwns(x + left - page.left - page.translationX, y + top - page.top - page.translationY)
            }
    }

    private fun forward(page: OccludingSurfaceLayout, event: MotionEvent, action: Int? = null, send: (MotionEvent) -> Boolean): Boolean {
        val copy = MotionEvent.obtain(event)
        if (action != null) copy.action = action
        copy.offsetLocation(left - page.left - page.translationX, top - page.top - page.translationY)
        try {
            return send(copy)
        } finally {
            copy.recycle()
        }
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            touchTarget = null
            // A split later finger of a host gesture arrives as a DOWN with that gesture's down time.
            if (event.downTime == hostDownTime) return false
            val page = pageAt(event.x, event.y) ?: run {
                hostDownTime = event.downTime
                return false
            }
            touchTarget = page
        }
        val page = touchTarget ?: return false
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            touchTarget = null
        }
        // A page removed mid-gesture gets nothing more; the gesture still stays off the host.
        if (page.parent === parent) forward(page, event) { page.dispatchTouchEvent(it) }
        return true
    }

    override fun dispatchHoverEvent(event: MotionEvent): Boolean {
        val page = if (event.actionMasked == MotionEvent.ACTION_HOVER_EXIT) null else pageAt(event.x, event.y)
        val previous = hoverTarget
        if (page !== previous) {
            previous?.let { forward(it, event, MotionEvent.ACTION_HOVER_EXIT) { copy -> it.dispatchGenericMotionEvent(copy) } }
            hoverTarget = page
            if (page != null && event.actionMasked != MotionEvent.ACTION_HOVER_ENTER) {
                forward(page, event, MotionEvent.ACTION_HOVER_ENTER) { page.dispatchGenericMotionEvent(it) }
            }
        }
        if (page == null) return event.actionMasked == MotionEvent.ACTION_HOVER_EXIT && previous != null
        forward(page, event) { page.dispatchGenericMotionEvent(it) }
        return true
    }

    /** Mouse wheel and other pointer events that are neither touch nor hover. */
    override fun dispatchGenericPointerEvent(event: MotionEvent): Boolean {
        val page = pageAt(event.x, event.y) ?: return false
        forward(page, event) { page.dispatchGenericMotionEvent(it) }
        return true
    }
}
