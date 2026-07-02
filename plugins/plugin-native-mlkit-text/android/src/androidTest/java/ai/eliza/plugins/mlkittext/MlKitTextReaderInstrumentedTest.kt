package ai.eliza.plugins.mlkittext

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for ML Kit text recognition (issue #11001).
 *
 * Renders a known string into a bitmap, runs the real ML Kit Text Recognition
 * v2 engine through [MlKitTextReader] — the exact class the Capacitor plugin
 * ships — and asserts real text plus sane bounding boxes come back. Mirrors
 * the #9453 `connectedDebugAndroidTest` evidence pattern.
 *
 * Run: `./gradlew :elizaos-capacitor-mlkit-text:connectedDebugAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class MlKitTextReaderInstrumentedTest {

    private fun renderTextBitmap(lines: List<String>): Bitmap {
        val bitmap = Bitmap.createBitmap(900, 160 + lines.size * 120, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.BLACK
            textSize = 84f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        lines.forEachIndexed { index, line ->
            canvas.drawText(line, 48f, 140f + index * 120f, paint)
        }
        return bitmap
    }

    private fun recognizeBlocking(bitmap: Bitmap): List<OcrWord> {
        val latch = CountDownLatch(1)
        var words: List<OcrWord>? = null
        var failure: Exception? = null
        MlKitTextReader().recognize(
            bitmap,
            onSuccess = { result ->
                words = result
                latch.countDown()
            },
            onFailure = { error ->
                failure = error
                latch.countDown()
            },
        )
        assertTrue("recognition completes within 60s", latch.await(60, TimeUnit.SECONDS))
        failure?.let { throw AssertionError("ML Kit recognition failed: ${it.message}", it) }
        return requireNotNull(words)
    }

    @Test
    fun recognize_returnsRealTextAndBoxes() {
        val bitmap = renderTextBitmap(listOf("HELLO ELIZA 42", "OCR BRIDGE"))
        val words = recognizeBlocking(bitmap)

        assertTrue("recognizer returns words", words.isNotEmpty())
        val joined = words.joinToString(" ") { it.text.uppercase() }
        assertTrue("'$joined' contains HELLO", joined.contains("HELLO"))
        assertTrue("'$joined' contains ELIZA", joined.contains("ELIZA"))
        assertTrue("'$joined' contains 42", joined.contains("42"))
        assertTrue("'$joined' contains BRIDGE", joined.contains("BRIDGE"))

        for (word in words) {
            assertTrue("word '${word.text}' has positive box", word.width > 0 && word.height > 0)
            assertTrue("word '${word.text}' box inside bitmap", word.left >= 0 && word.top >= 0)
            assertTrue(
                "word '${word.text}' right edge inside bitmap",
                word.left + word.width <= bitmap.width,
            )
            assertTrue(
                "word '${word.text}' bottom edge inside bitmap",
                word.top + word.height <= bitmap.height,
            )
            assertTrue("word '${word.text}' confidence sane", word.confidence in 0..100)
        }

        // The two rendered lines must land in different block/line groups so the
        // bridge's block/par/line grouping (mapOcrWordsToResult) stays meaningful.
        val groupKeys = words.map { "${it.block}/${it.par}/${it.line}" }.toSet()
        assertTrue("two rendered lines produce >= 2 groups, got $groupKeys", groupKeys.size >= 2)

        // Words on the first rendered line must sit above words on the second.
        val helloTop = words.first { it.text.uppercase().contains("HELLO") }.top
        val bridgeTop = words.first { it.text.uppercase().contains("BRIDGE") }.top
        assertTrue("HELLO ($helloTop) renders above BRIDGE ($bridgeTop)", helloTop < bridgeTop)
    }

    @Test
    fun recognize_blankImageReturnsNoWords() {
        val blank = Bitmap.createBitmap(400, 200, Bitmap.Config.ARGB_8888).apply {
            Canvas(this).drawColor(Color.WHITE)
        }
        val words = recognizeBlocking(blank)
        assertTrue("blank image yields no words, got $words", words.isEmpty())
    }
}
