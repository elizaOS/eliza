/**
 * The `below-host` layer: the website is drawn under a transparent host WebView, so the
 * host paints its own chrome (with anti-aliased edges and shadows) over the page and no
 * hole is cut in the website. The host WebView consumes every touch it receives, so
 * [BelowHostInputRouter] sits just above it and sends each gesture that starts on the
 * page, outside every host-owned rect, to the website for the whole gesture.
 */
package ai.eliza.plugins.browsersurface

import android.content.Context
import android.os.Parcel
import android.view.DragEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup

internal enum class SurfaceLayer(val wire: String) {
    ABOVE_HOST("above-host"),
    BELOW_HOST("below-host"),
    ;

    companion object {
        /**
         * The `layer` option: absent or null is `above-host`; any other value that is not a
         * known name (a typo, a number, a boolean) is null and must be rejected.
         */
        fun parse(value: Any?): SurfaceLayer? =
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
 * True when the input router may send touches to this surface: a shown below-host page
 * that is not paused (a paused page draws nothing, so a tap would act unseen).
 */
internal fun takesPageInput(layer: SurfaceLayer, foregrounded: Boolean, paused: Boolean, disposed: Boolean): Boolean =
    layer == SurfaceLayer.BELOW_HOST && foregrounded && !paused && !disposed

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

/** Puts [router] directly above [branch] in [host]; does nothing when it is already there. */
internal fun placeRouter(host: ViewGroup, branch: View, router: View) {
    if (router.parent === host && host.indexOfChild(router) == host.indexOfChild(branch) + 1) return
    (router.parent as? ViewGroup)?.removeView(router)
    host.addView(
        router,
        host.indexOfChild(branch) + 1,
        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
}

/**
 * Brings a presented surface into place: an `above-host` page over everything, as before;
 * a `below-host` page stays under the host, with [router] kept directly above the host.
 */
internal fun raiseSurface(host: ViewGroup, container: OccludingSurfaceLayout, branch: View?, router: () -> View) {
    if (container.layer == SurfaceLayer.ABOVE_HOST) {
        container.bringToFront()
    } else if (branch != null) {
        placeRouter(host, branch, router())
    }
}

/**
 * A copy of [event] with [action] at ([x], [y]), or null when the copy cannot be made.
 * DragEvent has no public way to move its point; its parcel starts with the action and
 * the point, and the copy is checked, so a different layout gives null, never a wrong
 * point. The copy has no local state, which only a drag started in this app sets.
 */
internal fun movedDragEvent(event: DragEvent, action: Int, x: Float, y: Float): DragEvent? {
    val parcel = Parcel.obtain()
    return try {
        event.writeToParcel(parcel, 0)
        parcel.setDataPosition(0)
        parcel.writeInt(action)
        parcel.writeFloat(x)
        parcel.writeFloat(y)
        parcel.setDataPosition(0)
        DragEvent.CREATOR.createFromParcel(parcel).takeIf { it.action == action && it.x == x && it.y == y }
    } catch (_: RuntimeException) {
        null
    } finally {
        parcel.recycle()
    }
}

/**
 * An empty, never-drawn view placed just above the host WebView. It claims a touch,
 * hover, mouse or drag event that starts where a visible below-host page owns the point
 * and forwards it to that page; every other event falls through to the host WebView. The
 * host never sees a routed gesture, and the page never sees one that started on host
 * chrome, including later fingers of the same gesture.
 */
internal class BelowHostInputRouter(
    context: Context,
    private val dragView: (OccludingSurfaceLayout?) -> View?,
    private val pages: () -> List<OccludingSurfaceLayout>,
) : View(context) {
    private class Drag(val entered: DragEvent, val exited: DragEvent, var target: View? = null) {
        fun select(next: View?) {
            if (target === next) return
            target?.takeIf { it.isAttachedToWindow }?.onDragEvent(exited)
            target = next
            next?.onDragEvent(entered)
        }
    }
    private var drag: Drag? = null
    private var touchTarget: OccludingSurfaceLayout? = null

    /** True from a routed DOWN to its UP or CANCEL, even after the page was hidden. */
    private var touchRouted = false
    private var hoverTarget: OccludingSurfaceLayout? = null

    /** Down time of the last gesture left to the host; its later split fingers stay there. */
    private var hostDownTime = Long.MIN_VALUE

    init {
        setWillNotDraw(true)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    /** Whether [page] is still shown, foregrounded and in this view's parent. */
    private fun isLive(page: OccludingSurfaceLayout): Boolean =
        page.parent === parent && page.visibility == VISIBLE && pages().any { it === page }

    /** The topmost visible page under a point in this view's coordinates. */
    private fun pageAt(x: Float, y: Float): OccludingSurfaceLayout? {
        val parent = parent as? ViewGroup ?: return null
        val candidates = pages()
        if (candidates.isEmpty()) return null
        var best: OccludingSurfaceLayout? = null
        var bestIndex = -1
        for (page in candidates) {
            if (page.parent !== parent || page.visibility != VISIBLE) continue
            val index = parent.indexOfChild(page)
            if (index > bestIndex && page.pageOwns(x + left - page.left - page.translationX, y + top - page.top - page.translationY)) {
                best = page
                bestIndex = index
            }
        }
        return best
    }

    private fun forward(page: View, event: MotionEvent, action: Int? = null, send: (MotionEvent) -> Boolean): Boolean {
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
            touchRouted = false
            // A split later finger of a host gesture arrives as a DOWN with that gesture's down time.
            if (event.downTime == hostDownTime) return false
            val page = pageAt(event.x, event.y) ?: run {
                hostDownTime = event.downTime
                return false
            }
            touchTarget = page
            touchRouted = true
        }
        if (!touchRouted) return false
        val ends = event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL
        if (ends) touchRouted = false
        val page = touchTarget ?: return true
        if (ends) touchTarget = null
        if (!isLive(page)) {
            // A page hidden or removed mid-gesture is cancelled once; the rest of the
            // gesture is swallowed, so a lifted finger cannot click a hidden page.
            touchTarget = null
            if (page.parent === parent) forward(page, event, MotionEvent.ACTION_CANCEL) { page.dispatchTouchEvent(it) }
            return true
        }
        forward(page, event) { page.dispatchTouchEvent(it) }
        return true
    }

    override fun dispatchHoverEvent(event: MotionEvent): Boolean {
        val page = if (event.actionMasked == MotionEvent.ACTION_HOVER_EXIT) null else pageAt(event.x, event.y)
        val previous = hoverTarget
        if (page !== previous) {
            previous?.let {
                if (it.parent === parent) forward(it, event, MotionEvent.ACTION_HOVER_EXIT) { copy -> it.dispatchGenericMotionEvent(copy) }
            }
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

    override fun onDragEvent(event: DragEvent): Boolean {
        when (event.action) {
            DragEvent.ACTION_DRAG_STARTED -> {
                drag = null
                if (pages().isEmpty()) return false
                val entered = movedDragEvent(event, DragEvent.ACTION_DRAG_ENTERED, 0f, 0f) ?: return false
                val exited = movedDragEvent(event, DragEvent.ACTION_DRAG_EXITED, 0f, 0f) ?: return false
                drag = Drag(entered, exited)
            }
            DragEvent.ACTION_DRAG_LOCATION, DragEvent.ACTION_DROP -> {
                val active = drag ?: return false
                val target = dragView(pageAt(event.x, event.y))?.takeIf { it.isShown }
                active.select(target)
                if (target == null) return false
                val here = IntArray(2).also(::getLocationInWindow)
                val there = IntArray(2).also(target::getLocationInWindow)
                val x = event.x + here[0] - there[0]
                val y = event.y + here[1] - there[1]
                val local = if (x == event.x && y == event.y) event else movedDragEvent(event, event.action, x, y) ?: return false
                return target.onDragEvent(local)
            }
            DragEvent.ACTION_DRAG_EXITED -> drag?.select(null)
            DragEvent.ACTION_DRAG_ENDED -> drag = null
        }
        return true
    }
}
