package ai.eliza.plugins.canvas

import android.graphics.*
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URL
import java.util.UUID
import kotlin.math.tan

@CapacitorPlugin(name = "ElizaCanvas")
class CanvasPlugin : Plugin() {

    private val canvases = mutableMapOf<String, ManagedCanvas>()
    private var nextCanvasId = 1
    private var nextLayerId = 1

    // ---- Data Structures ----

    data class CanvasSize(val width: Int, val height: Int)

    class ManagedCanvas(
        val id: String,
        var view: CanvasView,
        var webView: WebView? = null,
        var layers: MutableMap<String, ManagedLayer> = mutableMapOf(),
        var size: CanvasSize,
        var touchEnabled: Boolean = false,
        var globalTransform: Matrix = Matrix()
    )

    data class ManagedLayer(
        val id: String,
        var name: String?,
        var visible: Boolean,
        var opacity: Float,
        var zIndex: Int,
        var view: CanvasView
    )

    // ---- CanvasView: a View backed by a Bitmap/Canvas ----

    class CanvasView(context: android.content.Context, private var size: CanvasSize) :
        View(context) {

        private var bitmap: Bitmap =
            Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888)
        private var drawCanvas: Canvas = Canvas(bitmap)
        private val drawPaint = Paint()
        var touchHandler: ((String, List<TouchInfo>) -> Unit)? = null

        data class TouchInfo(
            val id: Int, val x: Float, val y: Float, val pressure: Float?
        )

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            canvas.drawBitmap(bitmap, 0f, 0f, null)
        }

        fun getDrawCanvas(): Canvas = drawCanvas
        fun getBitmap(): Bitmap = bitmap

        fun clear(rect: RectF? = null) {
            if (rect != null) {
                drawPaint.xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
                drawCanvas.drawRect(rect, drawPaint)
                drawPaint.xfermode = null
            } else {
                bitmap.eraseColor(Color.TRANSPARENT)
            }
            invalidate()
        }

        fun resize(newSize: CanvasSize) {
            val newBitmap =
                Bitmap.createBitmap(newSize.width, newSize.height, Bitmap.Config.ARGB_8888)
            val newCanvas = Canvas(newBitmap)
            newCanvas.drawBitmap(bitmap, 0f, 0f, null)
            bitmap.recycle()
            bitmap = newBitmap
            drawCanvas = newCanvas
            size = newSize
            invalidate()
        }

        fun setImage(bmp: Bitmap?) {
            if (bmp == null) {
                bitmap.eraseColor(Color.TRANSPARENT)
            } else {
                drawCanvas.drawBitmap(bmp, 0f, 0f, null)
            }
            invalidate()
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            val type = when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> "start"
                MotionEvent.ACTION_MOVE -> "move"
                MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> "end"
                MotionEvent.ACTION_CANCEL -> "cancel"
                else -> return super.onTouchEvent(event)
            }

            val touches = mutableListOf<TouchInfo>()
            for (i in 0 until event.pointerCount) {
                touches.add(
                    TouchInfo(
                        id = event.getPointerId(i),
                        x = event.getX(i),
                        y = event.getY(i),
                        pressure = if (event.getPressure(i) > 0) event.getPressure(i) else null
                    )
                )
            }

            touchHandler?.invoke(type, touches)
            return true
        }

        fun commit() {
            invalidate()
        }
    }

    // ---- Create / Destroy ----

    @PluginMethod
    fun create(call: PluginCall) {
        val sizeObj = call.getObject("size") ?: run {
            call.reject("Missing size parameter")
            return
        }

        val width = sizeObj.int("width", 100)
        val height = sizeObj.int("height", 100)
        val size = CanvasSize(width, height)

        val canvasId = "canvas_${nextCanvasId++}"

        activity.runOnUiThread {
            val view = CanvasView(context, size)
            view.layoutParams = ViewGroup.LayoutParams(width, height)

            val bgColorObj = call.getObject("backgroundColor")
            if (bgColorObj != null) {
                val color = colorFromObject(bgColorObj)
                view.setBackgroundColor(color)
            }

            val canvas = ManagedCanvas(canvasId, view, size = size)
            canvases[canvasId] = canvas

            call.resolve(JSObject().apply {
                put("canvasId", canvasId)
            })
        }
    }

    @PluginMethod
    fun destroy(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }

        activity.runOnUiThread {
            canvases[canvasId]?.let { canvas ->
                canvas.webView?.let { wv ->
                    wv.destroy()
                    (wv.parent as? ViewGroup)?.removeView(wv)
                }
                (canvas.view.parent as? ViewGroup)?.removeView(canvas.view)
                canvas.layers.values.forEach { layer ->
                    (layer.view.parent as? ViewGroup)?.removeView(layer.view)
                }
            }
            canvases.remove(canvasId)
            call.resolve()
        }
    }

    // ---- Attach / Detach ----

    @PluginMethod
    fun attach(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }

        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        activity.runOnUiThread {
            val webView = bridge.webView
            val parent = webView?.parent as? ViewGroup

            if (parent != null) {
                canvas.view.layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )

                parent.addView(canvas.view, 0)
                webView.setBackgroundColor(Color.TRANSPARENT)

                // If a web canvas exists, ensure it's also in the hierarchy.
                canvas.webView?.let { wv ->
                    if (wv.parent == null) {
                        wv.layoutParams = FrameLayout.LayoutParams(
                            FrameLayout.LayoutParams.MATCH_PARENT,
                            FrameLayout.LayoutParams.MATCH_PARENT
                        )
                        parent.addView(wv, 0)
                    }
                }

                // Set up touch handler.
                canvas.view.touchHandler = { type, touches ->
                    if (canvas.touchEnabled) {
                        val touchArray = JSArray()
                        touches.forEach { touch ->
                            touchArray.put(JSObject().apply {
                                put("id", touch.id)
                                put("x", touch.x.toDouble())
                                put("y", touch.y.toDouble())
                                touch.pressure?.let { put("force", it.toDouble()) }
                            })
                        }

                        notifyListeners("touch", JSObject().apply {
                            put("type", type)
                            put("touches", touchArray)
                            put("timestamp", System.currentTimeMillis())
                        })
                    }
                }
            }

            call.resolve()
        }
    }

    @PluginMethod
    fun detach(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }

        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        activity.runOnUiThread {
            (canvas.view.parent as? ViewGroup)?.removeView(canvas.view)
            call.resolve()
        }
    }

    // ---- Resize / Clear ----

    @PluginMethod
    fun resize(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }

        val sizeObj = call.getObject("size") ?: run {
            call.reject("Missing size")
            return
        }

        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        val width = sizeObj.int("width", canvas.size.width)
        val height = sizeObj.int("height", canvas.size.height)
        val newSize = CanvasSize(width, height)

        activity.runOnUiThread {
            canvas.size = newSize
            canvas.view.resize(newSize)
            canvas.webView?.layoutParams =
                FrameLayout.LayoutParams(width, height)
            canvas.layers.values.forEach { it.view.resize(newSize) }
            call.resolve()
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }

        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        val layerId = call.getString("layerId")
        val rectObj = call.getObject("rect")

        activity.runOnUiThread {
            val targetView = layerId?.let { canvas.layers[it]?.view } ?: canvas.view

            val rect = rectObj?.let {
                RectF(
                    it.float("x"),
                    it.float("y"),
                    it.float("x") + it.float("width"),
                    it.float("y") + it.float("height")
                )
            }

            targetView.clear(rect)
            call.resolve()
        }
    }

    // ---- Layer Operations ----

    @PluginMethod
    fun createLayer(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }

        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        val layerObj = call.getObject("layer") ?: run {
            call.reject("Missing layer")
            return
        }

        val layerId = "layer_${nextLayerId++}"
        val visible = layerObj.boolean("visible", true)
        val opacity = layerObj.float("opacity", 1f)
        val zIndex = layerObj.int("zIndex")
        val name = layerObj.getString("name")

        activity.runOnUiThread {
            val view = CanvasView(context, canvas.size)
            view.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            view.alpha = opacity
            view.visibility = if (visible) View.VISIBLE else View.GONE

            val layer = ManagedLayer(layerId, name, visible, opacity, zIndex, view)
            canvas.layers[layerId] = layer

            val parent = canvas.view.parent as? ViewGroup
            parent?.addView(view)
            sortLayers(canvas)

            call.resolve(JSObject().apply {
                put("layerId", layerId)
            })
        }
    }

    @PluginMethod
    fun updateLayer(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val layerId = call.getString("layerId") ?: run {
            call.reject("Missing layerId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val layer = canvas.layers[layerId] ?: run {
            call.reject("Layer not found")
            return
        }
        val layerObj = call.getObject("layer") ?: run {
            call.reject("Missing layer")
            return
        }

        activity.runOnUiThread {
            layerObj.booleanOrNull("visible")?.let {
                layer.visible = it
                layer.view.visibility = if (it) View.VISIBLE else View.GONE
            }
            layerObj.floatOrNull("opacity")?.let {
                layer.opacity = it
                layer.view.alpha = layer.opacity
            }
            layerObj.intOrNull("zIndex")?.let {
                layer.zIndex = it
                sortLayers(canvas)
            }
            layerObj.getString("name")?.let {
                layer.name = it
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun deleteLayer(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val layerId = call.getString("layerId") ?: run {
            call.reject("Missing layerId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val layer = canvas.layers[layerId] ?: run {
            call.reject("Layer not found")
            return
        }

        activity.runOnUiThread {
            (layer.view.parent as? ViewGroup)?.removeView(layer.view)
            canvas.layers.remove(layerId)
            call.resolve()
        }
    }

    @PluginMethod
    fun getLayers(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        val layers = JSArray()
        canvas.layers.values.forEach { layer ->
            layers.put(JSObject().apply {
                put("id", layer.id)
                put("visible", layer.visible)
                put("opacity", layer.opacity.toDouble())
                put("zIndex", layer.zIndex)
                layer.name?.let { put("name", it) }
            })
        }

        call.resolve(JSObject().apply {
            put("layers", layers)
        })
    }

    // ---- Drawing: Rect ----

    @PluginMethod
    fun drawRect(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val rectObj = call.getObject("rect") ?: run {
            call.reject("Missing rect")
            return
        }

        val drawOpts = call.getObject("drawOptions")
        val layerId = drawOpts?.getString("layerId")
        val fillObj = call.getObject("fill")
        val strokeObj = call.getObject("stroke")
        val cornerRadius = call.getFloat("cornerRadius") ?: 0f

        activity.runOnUiThread {
            val targetView = layerId?.let { canvas.layers[it]?.view } ?: canvas.view
            val drawCanvas = targetView.getDrawCanvas()
            val paint = Paint().apply { isAntiAlias = true }
            val saveCount = applyDrawOptions(drawCanvas, canvas, drawOpts)

            val rect = rectFromObject(rectObj)

            fillObj?.let {
                val gradient = extractGradient(it)
                if (gradient != null) {
                    paint.shader = createShader(gradient)
                    paint.style = Paint.Style.FILL
                    if (cornerRadius > 0) {
                        drawCanvas.drawRoundRect(rect, cornerRadius, cornerRadius, paint)
                    } else {
                        drawCanvas.drawRect(rect, paint)
                    }
                    paint.shader = null
                } else {
                    paint.color = colorFromFillOrStroke(it)
                    paint.style = Paint.Style.FILL
                    if (cornerRadius > 0) {
                        drawCanvas.drawRoundRect(rect, cornerRadius, cornerRadius, paint)
                    } else {
                        drawCanvas.drawRect(rect, paint)
                    }
                }
            }

            strokeObj?.let {
                paint.color = colorFromFillOrStroke(it)
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = it.float("width", 1f)
                applyStrokeStyle(paint, it)
                if (cornerRadius > 0) {
                    drawCanvas.drawRoundRect(rect, cornerRadius, cornerRadius, paint)
                } else {
                    drawCanvas.drawRect(rect, paint)
                }
            }

            restoreDrawOptions(drawCanvas, saveCount)
            targetView.commit()
            call.resolve()
        }
    }

    // ---- Drawing: Ellipse ----

    @PluginMethod
    fun drawEllipse(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val centerObj = call.getObject("center") ?: run {
            call.reject("Missing center")
            return
        }

        val radiusX = call.getFloat("radiusX") ?: 0f
        val radiusY = call.getFloat("radiusY") ?: 0f
        val drawOpts = call.getObject("drawOptions")
        val layerId = drawOpts?.getString("layerId")
        val fillObj = call.getObject("fill")
        val strokeObj = call.getObject("stroke")

        activity.runOnUiThread {
            val targetView = layerId?.let { canvas.layers[it]?.view } ?: canvas.view
            val drawCanvas = targetView.getDrawCanvas()
            val paint = Paint().apply { isAntiAlias = true }
            val saveCount = applyDrawOptions(drawCanvas, canvas, drawOpts)

            val cx = centerObj.float("x")
            val cy = centerObj.float("y")
            val rect = RectF(cx - radiusX, cy - radiusY, cx + radiusX, cy + radiusY)

            fillObj?.let {
                val gradient = extractGradient(it)
                if (gradient != null) {
                    paint.shader = createShader(gradient)
                    paint.style = Paint.Style.FILL
                    drawCanvas.drawOval(rect, paint)
                    paint.shader = null
                } else {
                    paint.color = colorFromFillOrStroke(it)
                    paint.style = Paint.Style.FILL
                    drawCanvas.drawOval(rect, paint)
                }
            }

            strokeObj?.let {
                paint.color = colorFromFillOrStroke(it)
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = it.float("width", 1f)
                applyStrokeStyle(paint, it)
                drawCanvas.drawOval(rect, paint)
            }

            restoreDrawOptions(drawCanvas, saveCount)
            targetView.commit()
            call.resolve()
        }
    }

    // ---- Drawing: Line ----

    @PluginMethod
    fun drawLine(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val fromObj = call.getObject("from") ?: run {
            call.reject("Missing from")
            return
        }
        val toObj = call.getObject("to") ?: run {
            call.reject("Missing to")
            return
        }
        val strokeObj = call.getObject("stroke") ?: run {
            call.reject("Missing stroke")
            return
        }
        val drawOpts = call.getObject("drawOptions")
        val layerId = drawOpts?.getString("layerId")

        activity.runOnUiThread {
            val targetView = layerId?.let { canvas.layers[it]?.view } ?: canvas.view
            val drawCanvas = targetView.getDrawCanvas()
            val saveCount = applyDrawOptions(drawCanvas, canvas, drawOpts)

            val paint = Paint().apply {
                isAntiAlias = true
                style = Paint.Style.STROKE
                color = colorFromFillOrStroke(strokeObj)
                strokeWidth = strokeObj.float("width", 1f)
            }
            applyStrokeStyle(paint, strokeObj)

            drawCanvas.drawLine(
                fromObj.float("x"),
                fromObj.float("y"),
                toObj.float("x"),
                toObj.float("y"),
                paint
            )

            restoreDrawOptions(drawCanvas, saveCount)
            targetView.commit()
            call.resolve()
        }
    }

    // ---- Drawing: Path ----

    @PluginMethod
    fun drawPath(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val pathObj = call.getObject("path") ?: run {
            call.reject("Missing path")
            return
        }
        val commands = pathObj.arrayOrNull("commands") ?: run {
            call.reject("Missing commands in path")
            return
        }

        val drawOpts = call.getObject("drawOptions")
        val layerId = drawOpts?.getString("layerId")
        val fillObj = call.getObject("fill")
        val strokeObj = call.getObject("stroke")

        activity.runOnUiThread {
            val targetView = layerId?.let { canvas.layers[it]?.view } ?: canvas.view
            val drawCanvas = targetView.getDrawCanvas()
            val paint = Paint().apply { isAntiAlias = true }
            val saveCount = applyDrawOptions(drawCanvas, canvas, drawOpts)

            val path = buildPath(commands)

            fillObj?.let {
                val gradient = extractGradient(it)
                if (gradient != null) {
                    paint.shader = createShader(gradient)
                    paint.style = Paint.Style.FILL
                    drawCanvas.drawPath(path, paint)
                    paint.shader = null
                } else {
                    paint.color = colorFromFillOrStroke(it)
                    paint.style = Paint.Style.FILL
                    drawCanvas.drawPath(path, paint)
                }
            }

            strokeObj?.let {
                paint.color = colorFromFillOrStroke(it)
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = it.float("width", 1f)
                applyStrokeStyle(paint, it)
                drawCanvas.drawPath(path, paint)
            }

            restoreDrawOptions(drawCanvas, saveCount)
            targetView.commit()
            call.resolve()
        }
    }

    /** Build an Android Path from the CanvasDrawPathCommand array. */
    private fun buildPath(commands: JSONArray): Path {
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

    // ---- Drawing: Text ----

    @PluginMethod
    fun drawText(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val text = call.getString("text") ?: run {
            call.reject("Missing text")
            return
        }
        val positionObj = call.getObject("position") ?: run {
            call.reject("Missing position")
            return
        }
        val styleObj = call.getObject("style") ?: run {
            call.reject("Missing style")
            return
        }
        val drawOpts = call.getObject("drawOptions")
        val layerId = drawOpts?.getString("layerId")

        activity.runOnUiThread {
            val targetView = layerId?.let { canvas.layers[it]?.view } ?: canvas.view
            val drawCanvas = targetView.getDrawCanvas()
            val saveCount = applyDrawOptions(drawCanvas, canvas, drawOpts)

            val fontSize = styleObj.float("size", 14f)
            val fontName = styleObj.getString("font") ?: "sans-serif"
            val align = styleObj.getString("align") ?: "left"
            val baseline = styleObj.getString("baseline") ?: "alphabetic"
            val maxWidth = styleObj.floatOrNull("maxWidth")

            val typeface = try {
                Typeface.create(fontName, Typeface.NORMAL)
            } catch (_: Exception) {
                Typeface.DEFAULT
            }

            val paint = Paint().apply {
                isAntiAlias = true
                textSize = fontSize
                this.typeface = typeface
                color = colorFromFillOrStroke(styleObj)
                textAlign = when (align) {
                    "center" -> Paint.Align.CENTER
                    "right" -> Paint.Align.RIGHT
                    else -> Paint.Align.LEFT
                }
            }

            var x = positionObj.float("x")
            var y = positionObj.float("y")

            // Adjust for baseline.
            val metrics = paint.fontMetrics
            when (baseline) {
                "top" -> y -= metrics.top
                "middle" -> y -= (metrics.top + metrics.bottom) / 2
                "bottom" -> y -= metrics.bottom
                // "alphabetic" is the default baseline for drawText.
            }

            if (maxWidth != null) {
                // Scale text to fit within maxWidth.
                val textWidth = paint.measureText(text)
                if (textWidth > maxWidth) {
                    paint.textScaleX = maxWidth / textWidth
                }
            }

            drawCanvas.drawText(text, x, y, paint)

            restoreDrawOptions(drawCanvas, saveCount)
            targetView.commit()
            call.resolve()
        }
    }

    // ---- Drawing: Image ----

    @PluginMethod
    fun drawImage(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val destRectObj = call.getObject("destRect") ?: run {
            call.reject("Missing destRect")
            return
        }

        val drawOpts = call.getObject("drawOptions")
        val layerId = drawOpts?.getString("layerId")
        val imageObj = call.getObject("image")
        val imageString = call.getString("image")
        val srcRectObj = call.getObject("srcRect")

        activity.runOnUiThread {
            val targetView = layerId?.let { canvas.layers[it]?.view } ?: canvas.view
            val drawCanvas = targetView.getDrawCanvas()
            val saveCount = applyDrawOptions(drawCanvas, canvas, drawOpts)

            var bitmap: Bitmap? = null

            // Try to decode from base64 object.
            if (imageObj != null) {
                val base64 = imageObj.getString("base64")
                if (base64 != null) {
                    try {
                        val bytes = Base64.decode(base64, Base64.DEFAULT)
                        bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    } catch (_: Exception) {
                    }
                }
            }

            // Try to load from URL string (only for local/data URIs on main thread).
            if (bitmap == null && imageString != null) {
                try {
                    if (imageString.startsWith("data:")) {
                        val commaIdx = imageString.indexOf(',')
                        if (commaIdx > 0) {
                            val base64Data = imageString.substring(commaIdx + 1)
                            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        }
                    }
                } catch (_: Exception) {
                }
            }

            if (bitmap != null) {
                val destRect = rectFromObject(destRectObj)

                if (srcRectObj != null) {
                    // Crop source bitmap then draw into dest.
                    val srcRect = Rect(
                        srcRectObj.int("x"),
                        srcRectObj.int("y"),
                        (srcRectObj.double("x") + srcRectObj.double("width")).toInt(),
                        (srcRectObj.double("y") + srcRectObj.double("height")).toInt()
                    )
                    val dst = Rect(
                        destRect.left.toInt(), destRect.top.toInt(),
                        destRect.right.toInt(), destRect.bottom.toInt()
                    )
                    drawCanvas.drawBitmap(bitmap, srcRect, dst, null)
                } else {
                    val dst = Rect(
                        destRect.left.toInt(), destRect.top.toInt(),
                        destRect.right.toInt(), destRect.bottom.toInt()
                    )
                    drawCanvas.drawBitmap(bitmap, null, dst, null)
                }

                bitmap.recycle()
            }

            restoreDrawOptions(drawCanvas, saveCount)
            targetView.commit()
            call.resolve()
        }
    }

    // ---- Drawing: Batch ----

    @PluginMethod
    fun drawBatch(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val commands = call.getArray("commands") ?: run {
            call.reject("Missing commands")
            return
        }

        activity.runOnUiThread {
            val paint = Paint().apply { isAntiAlias = true }

            for (i in 0 until commands.length()) {
                val command = commands.getJSONObject(i) ?: continue
                val type = command.optString("type", "")
                val args = command.optJSONObject("args") ?: continue

                val drawOptsObj = args.optJSONObject("drawOptions")
                val targetLayerId = drawOptsObj?.optString("layerId")
                val targetView =
                    targetLayerId?.let { canvas.layers[it]?.view } ?: canvas.view
                val drawCanvas = targetView.getDrawCanvas()
                val drawOpts = drawOptsObj?.let { jsObjectFromJSON(it) }
                val saveCount = applyDrawOptions(drawCanvas, canvas, drawOpts)

                when (type) {
                    "rect" -> {
                        val rectJson = args.optJSONObject("rect")
                        if (rectJson != null) {
                            val rect = rectFromJSON(rectJson)
                            val cr = args.optDouble("cornerRadius", 0.0).toFloat()
                            val fillJson = args.optJSONObject("fill")
                            val strokeJson = args.optJSONObject("stroke")

                            fillJson?.let {
                                val fillObj = jsObjectFromJSON(it)
                                val gradient = extractGradient(fillObj)
                                if (gradient != null) {
                                    paint.shader = createShader(gradient)
                                } else {
                                    paint.shader = null
                                    paint.color = colorFromFillOrStroke(fillObj)
                                }
                                paint.style = Paint.Style.FILL
                                if (cr > 0) drawCanvas.drawRoundRect(rect, cr, cr, paint)
                                else drawCanvas.drawRect(rect, paint)
                                paint.shader = null
                            }
                            strokeJson?.let {
                                val strokeObj = jsObjectFromJSON(it)
                                paint.color = colorFromFillOrStroke(strokeObj)
                                paint.style = Paint.Style.STROKE
                                paint.strokeWidth =
                                    strokeObj.float("width", 1f)
                                applyStrokeStyle(paint, strokeObj)
                                if (cr > 0) drawCanvas.drawRoundRect(rect, cr, cr, paint)
                                else drawCanvas.drawRect(rect, paint)
                            }
                        }
                    }
                    "ellipse" -> {
                        val centerJson = args.optJSONObject("center")
                        if (centerJson != null) {
                            val cx = centerJson.optDouble("x", 0.0).toFloat()
                            val cy = centerJson.optDouble("y", 0.0).toFloat()
                            val rx = args.optDouble("radiusX", 0.0).toFloat()
                            val ry = args.optDouble("radiusY", 0.0).toFloat()
                            val ellRect =
                                RectF(cx - rx, cy - ry, cx + rx, cy + ry)

                            args.optJSONObject("fill")?.let {
                                val fillObj = jsObjectFromJSON(it)
                                val gradient = extractGradient(fillObj)
                                if (gradient != null) {
                                    paint.shader = createShader(gradient)
                                } else {
                                    paint.shader = null
                                    paint.color = colorFromFillOrStroke(fillObj)
                                }
                                paint.style = Paint.Style.FILL
                                drawCanvas.drawOval(ellRect, paint)
                                paint.shader = null
                            }
                            args.optJSONObject("stroke")?.let {
                                val strokeObj = jsObjectFromJSON(it)
                                paint.color = colorFromFillOrStroke(strokeObj)
                                paint.style = Paint.Style.STROKE
                                paint.strokeWidth =
                                    strokeObj.float("width", 1f)
                                applyStrokeStyle(paint, strokeObj)
                                drawCanvas.drawOval(ellRect, paint)
                            }
                        }
                    }
                    "line" -> {
                        val fromJson = args.optJSONObject("from")
                        val toJson = args.optJSONObject("to")
                        val strokeJson = args.optJSONObject("stroke")
                        if (fromJson != null && toJson != null && strokeJson != null) {
                            val strokeObj = jsObjectFromJSON(strokeJson)
                            paint.color = colorFromFillOrStroke(strokeObj)
                            paint.style = Paint.Style.STROKE
                            paint.strokeWidth =
                                strokeObj.float("width", 1f)
                            applyStrokeStyle(paint, strokeObj)
                            drawCanvas.drawLine(
                                fromJson.optDouble("x", 0.0).toFloat(),
                                fromJson.optDouble("y", 0.0).toFloat(),
                                toJson.optDouble("x", 0.0).toFloat(),
                                toJson.optDouble("y", 0.0).toFloat(),
                                paint
                            )
                        }
                    }
                    "path" -> {
                        val pathJson = args.optJSONObject("path")
                        val pathCommands = pathJson?.optJSONArray("commands")
                        if (pathCommands != null) {
                            val androidPath = buildPath(pathCommands)
                            args.optJSONObject("fill")?.let {
                                val fillObj = jsObjectFromJSON(it)
                                val gradient = extractGradient(fillObj)
                                if (gradient != null) {
                                    paint.shader = createShader(gradient)
                                } else {
                                    paint.shader = null
                                    paint.color = colorFromFillOrStroke(fillObj)
                                }
                                paint.style = Paint.Style.FILL
                                drawCanvas.drawPath(androidPath, paint)
                                paint.shader = null
                            }
                            args.optJSONObject("stroke")?.let {
                                val strokeObj = jsObjectFromJSON(it)
                                paint.color = colorFromFillOrStroke(strokeObj)
                                paint.style = Paint.Style.STROKE
                                paint.strokeWidth =
                                    strokeObj.float("width", 1f)
                                applyStrokeStyle(paint, strokeObj)
                                drawCanvas.drawPath(androidPath, paint)
                            }
                        }
                    }
                    "text" -> {
                        val textStr = args.optString("text", "")
                        val posJson = args.optJSONObject("position")
                        val styleJson = args.optJSONObject("style")
                        if (textStr.isNotEmpty() && posJson != null && styleJson != null) {
                            val styleObj = jsObjectFromJSON(styleJson)
                            val textPaint = Paint().apply {
                                isAntiAlias = true
                                textSize = styleObj.float("size", 14f)
                                color = colorFromFillOrStroke(styleObj)
                                textAlign = when (styleObj.getString("align")) {
                                    "center" -> Paint.Align.CENTER
                                    "right" -> Paint.Align.RIGHT
                                    else -> Paint.Align.LEFT
                                }
                            }
                            drawCanvas.drawText(
                                textStr,
                                posJson.optDouble("x", 0.0).toFloat(),
                                posJson.optDouble("y", 0.0).toFloat(),
                                textPaint
                            )
                        }
                    }
                    "image" -> {
                        val destRectJson = args.optJSONObject("destRect")
                        if (destRectJson != null) {
                            val destRect = rectFromJSON(destRectJson)
                            var bmp: Bitmap? = null
                            val imgObj = args.optJSONObject("image")
                            if (imgObj != null) {
                                val b64 = imgObj.optString("base64", "")
                                if (b64.isNotEmpty()) {
                                    try {
                                        val bytes = Base64.decode(b64, Base64.DEFAULT)
                                        bmp = BitmapFactory.decodeByteArray(
                                            bytes, 0, bytes.size
                                        )
                                    } catch (_: Exception) {
                                    }
                                }
                            }
                            if (bmp != null) {
                                val dst = Rect(
                                    destRect.left.toInt(), destRect.top.toInt(),
                                    destRect.right.toInt(), destRect.bottom.toInt()
                                )
                                drawCanvas.drawBitmap(bmp, null, dst, null)
                                bmp.recycle()
                            }
                        }
                    }
                    "clear" -> {
                        val clearRectJson = args.optJSONObject("rect")
                        val clearLayerId = args.stringOrNull("layerId")
                        val clearView =
                            clearLayerId?.let { canvas.layers[it]?.view } ?: targetView
                        if (clearRectJson != null) {
                            clearView.clear(rectFromJSON(clearRectJson))
                        } else {
                            clearView.clear()
                        }
                    }
                }

                restoreDrawOptions(drawCanvas, saveCount)
                targetView.commit()
            }

            call.resolve()
        }
    }

    // ---- Pixel Data / Export ----

    @PluginMethod
    fun getPixelData(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val rectObj = call.getObject("rect")

        activity.runOnUiThread {
            val bitmap = canvas.view.getBitmap()

            val region = if (rectObj != null) {
                val x = rectObj.int("x")
                val y = rectObj.int("y")
                val w = rectObj.int("width", bitmap.width)
                val h = rectObj.int("height", bitmap.height)
                Rect(x, y, (x + w).coerceAtMost(bitmap.width), (y + h).coerceAtMost(bitmap.height))
            } else {
                Rect(0, 0, bitmap.width, bitmap.height)
            }

            val w = region.width()
            val h = region.height()
            if (w <= 0 || h <= 0) {
                call.reject("Invalid dimensions")
                return@runOnUiThread
            }

            // Extract RGBA pixel data.
            val pixels = IntArray(w * h)
            bitmap.getPixels(pixels, 0, w, region.left, region.top, w, h)

            // Convert ARGB int array to RGBA byte array.
            val rgba = ByteArray(w * h * 4)
            for (i in pixels.indices) {
                val pixel = pixels[i]
                val offset = i * 4
                rgba[offset] = ((pixel shr 16) and 0xFF).toByte()     // R
                rgba[offset + 1] = ((pixel shr 8) and 0xFF).toByte()  // G
                rgba[offset + 2] = (pixel and 0xFF).toByte()          // B
                rgba[offset + 3] = ((pixel shr 24) and 0xFF).toByte() // A
            }

            val base64 = Base64.encodeToString(rgba, Base64.NO_WRAP)

            call.resolve(JSObject().apply {
                put("data", base64)
                put("width", w)
                put("height", h)
            })
        }
    }

    @PluginMethod
    fun toImage(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        val format = call.getString("format") ?: "png"
        val quality = call.getInt("quality") ?: 100
        val layerIds = call.getArray("layerIds")

        activity.runOnUiThread {
            val bitmap: Bitmap

            if (layerIds != null && layerIds.length() > 0) {
                // Composite only specified layers.
                bitmap = Bitmap.createBitmap(
                    canvas.size.width, canvas.size.height, Bitmap.Config.ARGB_8888
                )
                val compositeCanvas = Canvas(bitmap)
                for (i in 0 until layerIds.length()) {
                    val lid = layerIds.getString(i)
                    canvas.layers[lid]?.let { layer ->
                        compositeCanvas.drawBitmap(layer.view.getBitmap(), 0f, 0f, null)
                    }
                }
            } else {
                // Draw the main canvas view plus all layers.
                bitmap = Bitmap.createBitmap(
                    canvas.size.width, canvas.size.height, Bitmap.Config.ARGB_8888
                )
                val compositeCanvas = Canvas(bitmap)
                compositeCanvas.drawBitmap(canvas.view.getBitmap(), 0f, 0f, null)
                canvas.layers.values.sortedBy { it.zIndex }.forEach { layer ->
                    if (layer.visible) {
                        val layerPaint = Paint().apply { alpha = (layer.opacity * 255).toInt() }
                        compositeCanvas.drawBitmap(
                            layer.view.getBitmap(), 0f, 0f, layerPaint
                        )
                    }
                }
            }

            val outputStream = ByteArrayOutputStream()
            val compressFormat = when (format) {
                "jpeg" -> Bitmap.CompressFormat.JPEG
                "webp" -> if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                    Bitmap.CompressFormat.WEBP_LOSSY
                } else {
                    @Suppress("DEPRECATION")
                    Bitmap.CompressFormat.WEBP
                }
                else -> Bitmap.CompressFormat.PNG
            }

            bitmap.compress(compressFormat, quality, outputStream)
            val base64 = Base64.encodeToString(outputStream.toByteArray(), Base64.NO_WRAP)
            val outputFormat = if (format == "webp" &&
                android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R
            ) "png" else format

            bitmap.recycle()

            call.resolve(JSObject().apply {
                put("base64", base64)
                put("format", outputFormat)
                put("width", canvas.size.width)
                put("height", canvas.size.height)
            })
        }
    }

    // ---- Transform ----

    @PluginMethod
    fun setTransform(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val transformObj = call.getObject("transform") ?: run {
            call.reject("Missing transform")
            return
        }

        canvas.globalTransform = matrixFromTransformObject(transformObj)
        call.resolve()
    }

    @PluginMethod
    fun resetTransform(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        canvas.globalTransform = Matrix()
        call.resolve()
    }

    // ---- Touch ----

    @PluginMethod
    fun setTouchEnabled(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val enabled = call.getBoolean("enabled") ?: false
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        activity.runOnUiThread {
            canvas.touchEnabled = enabled
            canvas.view.isClickable = enabled
            call.resolve()
        }
    }

    // ======== Web Canvas Operations ========

    // ---- Navigate ----

    @PluginMethod
    fun navigate(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val urlString = call.getString("url") ?: run {
            call.reject("Missing url")
            return
        }
        val placementObj = call.getObject("placement")

        activity.runOnUiThread {
            val wv = ensureWebView(canvas)

            // Apply placement if provided, otherwise fill the canvas.
            if (placementObj != null) {
                val x = placementObj.float("x")
                val y = placementObj.float("y")
                val w = placementObj.float("width", canvas.size.width.toFloat())
                val h = placementObj.float("height", canvas.size.height.toFloat())
                wv.x = x
                wv.y = y
                wv.layoutParams = FrameLayout.LayoutParams(w.toInt(), h.toInt())
            }

            val trimmed = urlString.trim()
            wv.loadUrl(trimmed)

            call.resolve(JSObject().apply {
                put("url", trimmed)
            })
        }
    }

    // ---- Eval ----

    @PluginMethod
    fun eval(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val script = call.getString("script") ?: run {
            call.reject("Missing script")
            return
        }

        val wv = canvas.webView ?: run {
            call.reject("No web view - call navigate() first")
            return
        }

        activity.runOnUiThread {
            wv.evaluateJavascript(script) { result ->
                call.resolve(JSObject().apply {
                    put("result", result ?: "")
                })
            }
        }
    }

    // ---- Snapshot ----

    @PluginMethod
    fun snapshot(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }

        val wv = canvas.webView ?: run {
            call.reject("No web view - call navigate() first")
            return
        }

        val maxWidth = call.getFloat("maxWidth")
        val quality = call.getDouble("quality") ?: 0.82
        val formatStr = call.getString("format") ?: "png"

        activity.runOnUiThread {
            // Capture the WebView as a bitmap (same approach as classic CanvasController).
            val width = wv.width.coerceAtLeast(1)
            val height = wv.height.coerceAtLeast(1)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val bitmapCanvas = Canvas(bitmap)
            wv.draw(bitmapCanvas)

            // Scale if maxWidth specified.
            val scaled = if (maxWidth != null && maxWidth > 0 && bitmap.width > maxWidth) {
                val scale = maxWidth / bitmap.width
                val newH = (bitmap.height * scale).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(bitmap, maxWidth.toInt(), newH, true).also {
                    if (it !== bitmap) bitmap.recycle()
                }
            } else {
                bitmap
            }

            val outputStream = ByteArrayOutputStream()
            val (compressFormat, compressQuality) = when (formatStr) {
                "jpeg" -> Bitmap.CompressFormat.JPEG to (quality * 100).toInt()
                    .coerceIn(1, 100)
                else -> Bitmap.CompressFormat.PNG to 100
            }
            scaled.compress(compressFormat, compressQuality, outputStream)
            val base64 = Base64.encodeToString(outputStream.toByteArray(), Base64.NO_WRAP)
            val outputFormat = if (formatStr == "jpeg") "jpeg" else "png"

            val resultWidth = scaled.width
            val resultHeight = scaled.height
            if (scaled !== bitmap) scaled.recycle()

            call.resolve(JSObject().apply {
                put("base64", base64)
                put("format", outputFormat)
                put("width", resultWidth)
                put("height", resultHeight)
            })
        }
    }

    // ---- A2UI Push ----

    @PluginMethod
    fun a2uiPush(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val wv = canvas.webView ?: run {
            call.reject("No web view - call navigate() first")
            return
        }

        // Accept "messages" (JSON array), "jsonl" (newline-delimited JSON string), or "payload".
        val messagesJSON: String = when {
            call.getArray("messages") != null -> {
                call.getArray("messages").toString()
            }
            call.getString("jsonl") != null -> {
                val jsonl = call.getString("jsonl")!!
                val parsed = JSONArray()
                for (line in jsonl.split("\n")) {
                    val trimmed = line.trim()
                    if (trimmed.isNotEmpty()) {
                        try {
                            parsed.put(JSONObject(trimmed))
                        } catch (e: Exception) {
                            call.reject("Invalid JSONL at line: ${trimmed.take(80)}")
                            return
                        }
                    }
                }
                parsed.toString()
            }
            call.getObject("payload") != null -> {
                val payload = call.getObject("payload")
                JSONArray().put(payload).toString()
            }
            else -> {
                call.reject("Missing messages, jsonl, or payload parameter")
                return
            }
        }

        val escapedJSON = jsStringLiteral(messagesJSON)

        val js = """
            (function() {
              try {
                var host = globalThis.elizaA2UI;
                if (host && typeof host.applyMessages === 'function') {
                  host.applyMessages(JSON.parse($escapedJSON));
                  return 'ok';
                }
                return 'a2ui_not_ready';
              } catch (e) {
                return 'error:' + e.message;
              }
            })()
        """.trimIndent()

        activity.runOnUiThread {
            wv.evaluateJavascript(js) { result ->
                val resultStr = result?.replace("\"", "") ?: ""
                when {
                    resultStr == "a2ui_not_ready" -> {
                        call.reject("A2UI host not ready - ensure the canvas page includes the A2UI runtime")
                    }
                    resultStr.startsWith("error:") -> {
                        call.reject("a2uiPush JS error: $resultStr")
                    }
                    else -> {
                        call.resolve()
                    }
                }
            }
        }
    }

    // ---- A2UI Reset ----

    @PluginMethod
    fun a2uiReset(call: PluginCall) {
        val canvasId = call.getString("canvasId") ?: run {
            call.reject("Missing canvasId")
            return
        }
        val canvas = canvases[canvasId] ?: run {
            call.reject("Canvas not found")
            return
        }
        val wv = canvas.webView ?: run {
            call.reject("No web view - call navigate() first")
            return
        }

        val js = """
            (function() {
              try {
                var host = globalThis.elizaA2UI;
                if (host && typeof host.reset === 'function') {
                  host.reset();
                  return 'ok';
                }
                return 'no_reset';
              } catch (e) {
                return 'error:' + e.message;
              }
            })()
        """.trimIndent()

        activity.runOnUiThread {
            wv.evaluateJavascript(js) { result ->
                if (result != null && result.contains("error:")) {
                    call.reject("a2uiReset failed: $result")
                } else {
                    call.resolve()
                }
            }
        }
    }

    // ======== Web View Management ========

    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private fun ensureWebView(canvas: ManagedCanvas): WebView {
        canvas.webView?.let { return it }

        val wv = WebView(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.allowFileAccess = true
            setBackgroundColor(Color.BLACK)
            isVerticalScrollBarEnabled = true
            isHorizontalScrollBarEnabled = true
        }

        // Set up the A2UI message bridge via JS interface.
        val canvasId = canvas.id
        val pluginRef = this
        wv.addJavascriptInterface(object {
            @JavascriptInterface
            fun postAction(actionJson: String) {
                try {
                    val json = JSONObject(actionJson)
                    val userAction = json.optJSONObject("userAction") ?: json
                    val actionName = extractActionName(userAction)
                    val actionId = userAction.optString("id", UUID.randomUUID().toString())
                    val surfaceId = userAction.optString("surfaceId", "main")

                    Handler(Looper.getMainLooper()).post {
                        pluginRef.notifyListeners("a2uiAction", JSObject().apply {
                            put("canvasId", canvasId)
                            put("actionId", actionId)
                            put("actionName", actionName ?: "")
                            put("surfaceId", surfaceId)
                            put("userAction", jsObjectFromJSON(userAction))
                        })

                        // Dispatch action status acknowledgement.
                        val statusJS = """
                            (function() {
                              var detail = { id: ${jsStringLiteral(actionId)}, ok: true, error: '' };
                              window.dispatchEvent(new CustomEvent('eliza:a2ui-action-status', { detail: detail }));
                            })();
                        """.trimIndent()
                        wv.evaluateJavascript(statusJS, null)
                    }
                } catch (_: Exception) {
                }
            }
        }, "elizaCanvasA2UIBridge")

        // Navigation delegate: intercept eliza:// deep links, emit events.
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url
                if (url.scheme?.lowercase() == "eliza") {
                    pluginRef.notifyListeners("deepLink", JSObject().apply {
                        put("canvasId", canvasId)
                        put("url", url.toString())
                    })
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)

                // Inject the A2UI bridge script so web content can post actions.
                val bridgeScript = """
                    (function() {
                      if (!window.webkit) window.webkit = {};
                      if (!window.webkit.messageHandlers) window.webkit.messageHandlers = {};
                      window.webkit.messageHandlers.elizaCanvasA2UIAction = {
                        postMessage: function(msg) {
                          var json = typeof msg === 'string' ? msg : JSON.stringify(msg);
                          elizaCanvasA2UIBridge.postAction(json);
                        }
                      };
                    })();
                """.trimIndent()
                view.evaluateJavascript(bridgeScript, null)

                pluginRef.notifyListeners("webViewReady", JSObject().apply {
                    put("canvasId", canvasId)
                    put("url", url ?: "")
                })
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                super.onReceivedError(view, request, error)
                pluginRef.notifyListeners("navigationError", JSObject().apply {
                    put("canvasId", canvasId)
                    put("error", error.description?.toString() ?: "Unknown error")
                    put("url", request.url?.toString() ?: "")
                })
            }
        }

        wv.webChromeClient = WebChromeClient()

        canvas.webView = wv

        // Insert the web view behind drawing layers in the canvas view hierarchy.
        if (canvas.view.parent != null) {
            wv.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            val parent = canvas.view.parent as? ViewGroup
            parent?.addView(wv, 0)
            canvas.view.setBackgroundColor(Color.TRANSPARENT)
        }

        return wv
    }

    // ======== Internal Helpers ========

    // ---- Draw Options: shadow, blend mode, opacity, transform ----

    /** Apply draw options and return the Canvas save count for later restore. */
    private fun applyDrawOptions(
        canvas: Canvas,
        managedCanvas: ManagedCanvas,
        options: JSObject?
    ): Int {
        val saveCount = canvas.save()

        // Global canvas transform.
        if (!managedCanvas.globalTransform.isIdentity) {
            canvas.concat(managedCanvas.globalTransform)
        }

        if (options == null) return saveCount

        // Per-operation transform.
        val transformObj = options.getJSObject("transform")
        if (transformObj != null) {
            canvas.concat(matrixFromTransformObject(transformObj))
        }

        // Blend mode via Paint is per-draw; opacity and shadow are applied via layer.
        val opacity = options.doubleOrNull("opacity")
        if (opacity != null && opacity < 1.0) {
            canvas.saveLayerAlpha(
                null, (opacity * 255).toInt().coerceIn(0, 255)
            )
        }

        return saveCount
    }

    private fun restoreDrawOptions(canvas: Canvas, saveCount: Int) {
        canvas.restoreToCount(saveCount)
    }

    // ---- Shadow ----

    private fun applyShadow(paint: Paint, shadowObj: JSObject?) {
        if (shadowObj == null) return
        val blur = shadowObj.float("blur")
        val offsetX = shadowObj.float("offsetX")
        val offsetY = shadowObj.float("offsetY")
        val colorObj = shadowObj.getJSObject("color")
        val colorStr = shadowObj.stringOrNull("color")
        val color = when {
            colorObj != null -> colorFromObject(colorObj)
            colorStr != null -> colorFromHexString(colorStr)
            else -> Color.argb(128, 0, 0, 0)
        }
        paint.setShadowLayer(blur, offsetX, offsetY, color)
    }

    // ---- Blend Mode ----

    private fun blendModeFromString(mode: String): PorterDuff.Mode {
        return when (mode) {
            "multiply" -> PorterDuff.Mode.MULTIPLY
            "screen" -> PorterDuff.Mode.SCREEN
            "overlay" -> PorterDuff.Mode.OVERLAY
            "darken" -> PorterDuff.Mode.DARKEN
            "lighten" -> PorterDuff.Mode.LIGHTEN
            else -> PorterDuff.Mode.SRC_OVER
        }
    }

    // ---- Stroke Style ----

    private fun applyStrokeStyle(paint: Paint, strokeObj: JSObject) {
        val lineCap = strokeObj.getString("lineCap")
        paint.strokeCap = when (lineCap) {
            "round" -> Paint.Cap.ROUND
            "square" -> Paint.Cap.SQUARE
            else -> Paint.Cap.BUTT
        }

        val lineJoin = strokeObj.getString("lineJoin")
        paint.strokeJoin = when (lineJoin) {
            "round" -> Paint.Join.ROUND
            "bevel" -> Paint.Join.BEVEL
            else -> Paint.Join.MITER
        }

        val dashPattern = strokeObj.arrayOrNull("dashPattern")
        if (dashPattern != null && dashPattern.length() > 0) {
            val intervals = FloatArray(dashPattern.length()) {
                dashPattern.optDouble(it, 0.0).toFloat()
            }
            if (intervals.size >= 2) {
                paint.pathEffect = DashPathEffect(intervals, 0f)
            }
        }
    }

    // ---- Gradient ----

    private fun extractGradient(obj: JSObject): JSObject? {
        val type = obj.getString("type") ?: return null
        if (type == "linear" || type == "radial") return obj
        return null
    }

    private fun createShader(gradientObj: JSObject): Shader {
        val type = gradientObj.getString("type") ?: "linear"
        val stops = gradientObj.arrayOrNull("stops")

        val colors = mutableListOf<Int>()
        val positions = mutableListOf<Float>()

        if (stops != null) {
            for (i in 0 until stops.length()) {
                val stop = stops.getJSONObject(i)
                positions.add(stop.optDouble("offset", 0.0).toFloat())

                val colorObj = stop.optJSONObject("color")
                val colorStr = stop.stringOrNull("color")
                val color = when {
                    colorObj != null -> colorFromObject(jsObjectFromJSON(colorObj))
                    colorStr != null && colorStr.startsWith("#") -> colorFromHexString(colorStr)
                    else -> Color.BLACK
                }
                colors.add(color)
            }
        }

        if (colors.isEmpty()) {
            colors.add(Color.BLACK)
            colors.add(Color.BLACK)
            positions.add(0f)
            positions.add(1f)
        }

        return when (type) {
            "radial" -> {
                val x0 = gradientObj.float("x0")
                val y0 = gradientObj.float("y0")
                val r1 = gradientObj.float("r1", 1f)
                RadialGradient(
                    x0, y0, r1.coerceAtLeast(0.001f),
                    colors.toIntArray(), positions.toFloatArray(),
                    Shader.TileMode.CLAMP
                )
            }
            else -> {
                val x0 = gradientObj.float("x0")
                val y0 = gradientObj.float("y0")
                val x1 = gradientObj.float("x1")
                val y1 = gradientObj.float("y1")
                LinearGradient(
                    x0, y0, x1, y1,
                    colors.toIntArray(), positions.toFloatArray(),
                    Shader.TileMode.CLAMP
                )
            }
        }
    }

    // ---- Transform ----

    private fun matrixFromTransformObject(obj: JSObject): Matrix {
        val m = Matrix()
        val tx = obj.float("translateX")
        val ty = obj.float("translateY")
        if (tx != 0f || ty != 0f) m.postTranslate(tx, ty)

        val sx = obj.floatOrNull("scaleX")
        val sy = obj.floatOrNull("scaleY")
        if (sx != null || sy != null) {
            m.postScale(sx ?: 1f, sy ?: 1f)
        }

        val rotation = obj.floatOrNull("rotation")
        if (rotation != null && rotation != 0f) {
            m.postRotate(Math.toDegrees(rotation.toDouble()).toFloat())
        }

        val skewX = obj.floatOrNull("skewX")
        if (skewX != null && skewX != 0f) {
            val skewMatrix = Matrix()
            skewMatrix.setSkew(tan(skewX.toDouble()).toFloat(), 0f)
            m.postConcat(skewMatrix)
        }

        val skewY = obj.floatOrNull("skewY")
        if (skewY != null && skewY != 0f) {
            val skewMatrix = Matrix()
            skewMatrix.setSkew(0f, tan(skewY.toDouble()).toFloat())
            m.postConcat(skewMatrix)
        }

        return m
    }

    // ---- Color Utilities ----

    private fun colorFromObject(obj: JSObject?): Int {
        if (obj == null) return Color.BLACK
        val r = obj.int("r")
        val g = obj.int("g")
        val b = obj.int("b")
        val a = (obj.double("a", 1.0) * 255).toInt()
        return Color.argb(a, r, g, b)
    }

    /**
     * Extract a color from a fill or stroke style object. Handles both `{ color: ... }` wrappers
     * and direct color objects, as well as hex string colors.
     */
    private fun colorFromFillOrStroke(obj: JSObject): Int {
        val colorObj = obj.getJSObject("color")
        if (colorObj != null) return colorFromObject(colorObj)

        val colorStr = obj.getString("color")
        if (colorStr != null) return colorFromHexString(colorStr)

        // Maybe the object itself is a color.
        if (obj.has("r")) return colorFromObject(obj)

        return Color.BLACK
    }

    private fun colorFromHexString(hex: String): Int {
        var sanitized = hex.trim().removePrefix("#")
        return try {
            when (sanitized.length) {
                6 -> {
                    val rgb = sanitized.toLong(16).toInt()
                    Color.rgb(
                        (rgb shr 16) and 0xFF,
                        (rgb shr 8) and 0xFF,
                        rgb and 0xFF
                    )
                }
                8 -> {
                    val rgba = sanitized.toLong(16)
                    Color.argb(
                        (rgba and 0xFF).toInt(),
                        ((rgba shr 24) and 0xFF).toInt(),
                        ((rgba shr 16) and 0xFF).toInt(),
                        ((rgba shr 8) and 0xFF).toInt()
                    )
                }
                else -> Color.BLACK
            }
        } catch (_: Exception) {
            Color.BLACK
        }
    }

    // ---- Rect Utilities ----

    private fun rectFromObject(obj: JSObject): RectF {
        val x = obj.float("x")
        val y = obj.float("y")
        val w = obj.float("width")
        val h = obj.float("height")
        return RectF(x, y, x + w, y + h)
    }

    private fun JSObject.boolean(name: String, defaultValue: Boolean = false): Boolean =
        booleanOrNull(name) ?: defaultValue

    private fun JSObject.booleanOrNull(name: String): Boolean? =
        if (has(name) && !isNull(name)) optBoolean(name) else null

    private fun JSObject.double(name: String, defaultValue: Double = 0.0): Double =
        doubleOrNull(name) ?: defaultValue

    private fun JSObject.doubleOrNull(name: String): Double? =
        if (has(name) && !isNull(name)) optDouble(name) else null

    private fun JSObject.float(name: String, defaultValue: Float = 0f): Float =
        doubleOrNull(name)?.toFloat() ?: defaultValue

    private fun JSObject.floatOrNull(name: String): Float? = doubleOrNull(name)?.toFloat()

    private fun JSObject.int(name: String, defaultValue: Int = 0): Int =
        intOrNull(name) ?: defaultValue

    private fun JSObject.intOrNull(name: String): Int? =
        if (has(name) && !isNull(name)) optInt(name) else null

    private fun JSObject.arrayOrNull(name: String): JSONArray? =
        if (has(name) && !isNull(name)) optJSONArray(name) else null

    private fun JSObject.stringOrNull(name: String): String? =
        if (has(name) && !isNull(name)) opt(name)?.takeUnless { it === JSONObject.NULL }?.toString() else null

    private fun JSONObject.stringOrNull(name: String): String? =
        if (has(name) && !isNull(name)) opt(name)?.takeUnless { it === JSONObject.NULL }?.toString() else null

    private fun rectFromJSON(obj: JSONObject): RectF {
        val x = obj.optDouble("x", 0.0).toFloat()
        val y = obj.optDouble("y", 0.0).toFloat()
        val w = obj.optDouble("width", 0.0).toFloat()
        val h = obj.optDouble("height", 0.0).toFloat()
        return RectF(x, y, x + w, y + h)
    }

    // ---- JSON Conversion ----

    private fun jsObjectFromJSON(json: JSONObject): JSObject {
        val result = JSObject()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            result.put(key, json.get(key))
        }
        return result
    }

    // ---- A2UI Action Name ----

    private fun extractActionName(userAction: JSONObject): String? {
        for (key in listOf("name", "action")) {
            val raw = userAction.optString(key, "").trim()
            if (raw.isNotEmpty()) return raw
        }
        return null
    }

    // ---- JS String Escape (matches iOS jsStringLiteral) ----

    private fun jsStringLiteral(value: String): String {
        val escaped = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        return "\"$escaped\""
    }

    // ---- Layer Sorting ----

    private fun sortLayers(canvas: ManagedCanvas) {
        val parent = canvas.view.parent as? ViewGroup ?: return
        val sorted = canvas.layers.values.sortedBy { it.zIndex }
        sorted.forEachIndexed { index, layer ->
            parent.removeView(layer.view)
            // Offset by 1 if web view is at index 0 inside canvas.view.
            parent.addView(layer.view, index + 1)
        }
    }

    // ---- Lifecycle ----

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        canvases.values.forEach { canvas ->
            canvas.webView?.destroy()
            (canvas.view.parent as? ViewGroup)?.removeView(canvas.view)
            canvas.layers.values.forEach { layer ->
                (layer.view.parent as? ViewGroup)?.removeView(layer.view)
            }
        }
        canvases.clear()
    }
}
