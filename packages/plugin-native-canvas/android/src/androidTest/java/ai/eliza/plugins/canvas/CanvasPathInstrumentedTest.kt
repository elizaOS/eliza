package ai.eliza.plugins.canvas

import android.graphics.RectF
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the canvas path-command interpreter (#9967).
 *
 * Drives [CanvasPath.buildPath] against the device's real `android.graphics.Path`
 * and asserts the resulting geometry via `computeBounds` — the drawing a mocked
 * Capacitor bridge in Chromium never exercised.
 */
@RunWith(AndroidJUnit4::class)
class CanvasPathInstrumentedTest {

    private fun cmd(type: String, vararg args: Double): JSONObject {
        val obj = JSONObject()
        obj.put("type", type)
        val arr = JSONArray()
        args.forEach { arr.put(it) }
        obj.put("args", arr)
        return obj
    }

    private fun commands(vararg c: JSONObject): JSONArray {
        val arr = JSONArray()
        c.forEach { arr.put(it) }
        return arr
    }

    private fun bounds(path: android.graphics.Path): RectF {
        val r = RectF()
        @Suppress("DEPRECATION")
        path.computeBounds(r, true)
        return r
    }

    @Test
    fun buildPath_emptyCommandsYieldAnEmptyPath() {
        assertTrue(CanvasPath.buildPath(JSONArray()).isEmpty)
    }

    @Test
    fun buildPath_moveToLineToProducesTheLineBounds() {
        val path = CanvasPath.buildPath(commands(cmd("moveTo", 10.0, 20.0), cmd("lineTo", 110.0, 220.0)))
        assertFalse(path.isEmpty)
        val b = bounds(path)
        assertEquals(10f, b.left, 0.01f)
        assertEquals(20f, b.top, 0.01f)
        assertEquals(110f, b.right, 0.01f)
        assertEquals(220f, b.bottom, 0.01f)
    }

    @Test
    fun buildPath_rectAddsXYWidthHeightRectangle() {
        // rect(x, y, w, h) → addRect(x, y, x+w, y+h)
        val path = CanvasPath.buildPath(commands(cmd("rect", 5.0, 5.0, 40.0, 30.0)))
        val b = bounds(path)
        assertEquals(5f, b.left, 0.01f)
        assertEquals(5f, b.top, 0.01f)
        assertEquals(45f, b.right, 0.01f)
        assertEquals(35f, b.bottom, 0.01f)
    }

    @Test
    fun buildPath_skipsUnknownAndUnderspecifiedCommandsWithoutThrowing() {
        val path = CanvasPath.buildPath(commands(cmd("bogus", 1.0), cmd("moveTo", 1.0)))
        assertTrue("malformed commands are no-ops", path.isEmpty)
    }

    @Test
    fun buildPath_bezierBoundsSpanTheControlPoints() {
        val path = CanvasPath.buildPath(
            commands(cmd("moveTo", 0.0, 0.0), cmd("bezierCurveTo", 0.0, 100.0, 100.0, 100.0, 100.0, 0.0)),
        )
        assertFalse(path.isEmpty)
        val b = bounds(path)
        assertEquals(0f, b.left, 0.01f)
        assertEquals(100f, b.right, 0.01f)
        assertEquals(0f, b.top, 0.01f)
        assertEquals(100f, b.bottom, 0.01f)
    }
}
