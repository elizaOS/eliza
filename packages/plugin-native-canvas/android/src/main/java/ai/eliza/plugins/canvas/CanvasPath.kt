package ai.eliza.plugins.canvas

import android.graphics.Matrix
import android.graphics.Path
import android.graphics.RectF
import org.json.JSONArray

/**
 * Pure, Bridge-free interpreter of JS canvas path commands into an Android [Path]
 * (#9967). Extracted out of [CanvasPlugin] so the moveTo/lineTo/curve/arc/ellipse/
 * rect/closePath geometry the canvas renders can be exercised by an on-device
 * instrumented test without a live canvas surface. [CanvasPlugin] delegates here.
 */
object CanvasPath {
    /** Interprets the JS canvas path commands into an Android [Path]. */
    fun buildPath(commands: JSONArray): Path {
        val path = Path()
        for (i in 0 until commands.length()) {
            val cmd = commands.getJSONObject(i)
            val type = cmd.optString("type", "")
            val args = cmd.optJSONArray("args") ?: JSONArray()
            val a = { idx: Int -> args.optDouble(idx, 0.0).toFloat() }

            when (type) {
                "moveTo" -> if (args.length() >= 2) {
                    path.moveTo(a(0), a(1))
                }
                "lineTo" -> if (args.length() >= 2) {
                    path.lineTo(a(0), a(1))
                }
                "quadraticCurveTo" -> if (args.length() >= 4) {
                    path.quadTo(a(0), a(1), a(2), a(3))
                }
                "bezierCurveTo" -> if (args.length() >= 6) {
                    path.cubicTo(a(0), a(1), a(2), a(3), a(4), a(5))
                }
                "arcTo" -> if (args.length() >= 5) {
                    // arcTo(x1, y1, x2, y2, radius) -- approximate with cubicTo.
                    // Android Path doesn't have tangent arc; use addArc as approximation.
                    val radius = a(4)
                    val oval = RectF(
                        a(0) - radius, a(1) - radius,
                        a(0) + radius, a(1) + radius
                    )
                    path.arcTo(oval, 0f, 90f)
                }
                "arc" -> if (args.length() >= 5) {
                    val cx = a(0)
                    val cy = a(1)
                    val radius = a(2)
                    val startAngle = Math.toDegrees(a(3).toDouble()).toFloat()
                    val endAngle = Math.toDegrees(a(4).toDouble()).toFloat()
                    val counterclockwise =
                        args.length() > 5 && args.optDouble(5, 0.0) != 0.0
                    val sweep = if (counterclockwise) {
                        -(((startAngle - endAngle) % 360 + 360) % 360)
                    } else {
                        (((endAngle - startAngle) % 360 + 360) % 360)
                    }
                    val oval = RectF(
                        cx - radius, cy - radius, cx + radius, cy + radius
                    )
                    path.arcTo(oval, startAngle, sweep)
                }
                "ellipse" -> if (args.length() >= 7) {
                    val cx = a(0)
                    val cy = a(1)
                    val rx = a(2)
                    val ry = a(3)
                    val rotation = a(4)
                    val startAngle = Math.toDegrees(a(5).toDouble()).toFloat()
                    val endAngle = Math.toDegrees(a(6).toDouble()).toFloat()
                    val counterclockwise =
                        args.length() > 7 && args.optDouble(7, 0.0) != 0.0
                    val sweep = if (counterclockwise) {
                        -(((startAngle - endAngle) % 360 + 360) % 360)
                    } else {
                        (((endAngle - startAngle) % 360 + 360) % 360)
                    }
                    val m = Matrix()
                    m.postTranslate(-cx, -cy)
                    m.postRotate(Math.toDegrees(rotation.toDouble()).toFloat())
                    m.postTranslate(cx, cy)
                    val subPath = Path()
                    val oval = RectF(cx - rx, cy - ry, cx + rx, cy + ry)
                    subPath.arcTo(oval, startAngle, sweep)
                    subPath.transform(m)
                    path.addPath(subPath)
                }
                "rect" -> if (args.length() >= 4) {
                    path.addRect(
                        a(0), a(1), a(0) + a(2), a(1) + a(3),
                        Path.Direction.CW
                    )
                }
                "closePath" -> path.close()
            }
        }
        return path
    }
}
