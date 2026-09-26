/**
 * Maps bundled on-device ML Kit recognition into the renderer's OCR word contract.
 * Confidence preserves the engine score on the bridge's 0–100 scale.
 */
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
    val confidence: Double,
    val block: Int,
    val par: Int,
    val line: Int,
)


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
                            confidence = element.confidence.toDouble() * 100.0,
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
