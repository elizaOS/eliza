package ai.eliza.plugins.mlkittext

import android.graphics.Bitmap
import android.graphics.Rect
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

data class OcrWord(
    val text: String,
    val left: Int,
    val top: Int,
    val width: Int,
    val height: Int,
    val confidence: Int,
    val block: Int,
    val par: Int,
    val line: Int,
)

/**
 * Engine wrapper around ML Kit Text Recognition v2 shared by the Capacitor
 * plugin and the instrumented test (issue #11001): one recognizer, one
 * word mapping, so the tested path is exactly the shipped path.
 */
class MlKitTextReader {
    private val recognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    fun recognize(
        bitmap: Bitmap,
        onSuccess: (List<OcrWord>) -> Unit,
        onFailure: (Exception) -> Unit,
    ) {
        recognizer.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { text -> onSuccess(mapWords(text)) }
            .addOnFailureListener(onFailure)
    }

    private fun mapWords(text: Text): List<OcrWord> {
        val words = mutableListOf<OcrWord>()
        text.textBlocks.forEachIndexed { blockIndex, block ->
            block.lines.forEachIndexed { lineIndex, line ->
                line.elements.forEach { element ->
                    val box = element.boundingBox ?: Rect()
                    words.add(
                        OcrWord(
                            text = element.text,
                            left = box.left,
                            top = box.top,
                            width = box.width(),
                            height = box.height(),
                            // ML Kit's Latin recognizer does not expose a
                            // per-element confidence; the bridge contract
                            // requires one, so report full confidence.
                            confidence = 100,
                            block = blockIndex,
                            par = 0,
                            line = lineIndex,
                        ),
                    )
                }
            }
        }
        return words
    }
}
