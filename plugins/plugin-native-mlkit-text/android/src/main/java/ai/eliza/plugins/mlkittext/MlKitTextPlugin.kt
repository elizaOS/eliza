package ai.eliza.plugins.mlkittext

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "Tesseract")
class MlKitTextPlugin : Plugin() {
    private val reader = MlKitTextReader()

    @PluginMethod
    fun recognize(call: PluginCall) {
        val imageBase64 = call.getString("image")
        if (imageBase64.isNullOrBlank()) {
            call.reject("image is required")
            return
        }

        val bitmap = try {
            decodeBitmap(imageBase64)
        } catch (error: Exception) {
            call.reject("invalid base64 image: ${error.message}")
            return
        }

        reader.recognize(
            bitmap,
            onSuccess = { words ->
                call.resolve(JSObject().apply { put("words", toJsArray(words)) })
            },
            onFailure = { error ->
                call.reject("ML Kit text recognition failed: ${error.message}")
            },
        )
    }

    private fun decodeBitmap(imageBase64: String): Bitmap {
        val comma = imageBase64.indexOf(',')
        val payload = if (comma >= 0) imageBase64.substring(comma + 1) else imageBase64
        val bytes = Base64.decode(payload, Base64.DEFAULT)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalArgumentException("decoded image is not a bitmap")
    }

    private fun toJsArray(words: List<OcrWord>): JSArray {
        val array = JSArray()
        for (word in words) {
            array.put(
                JSObject().apply {
                    put("text", word.text)
                    put("left", word.left)
                    put("top", word.top)
                    put("width", word.width)
                    put("height", word.height)
                    put("confidence", word.confidence)
                    put("block", word.block)
                    put("par", word.par)
                    put("line", word.line)
                },
            )
        }
        return array
    }
}
