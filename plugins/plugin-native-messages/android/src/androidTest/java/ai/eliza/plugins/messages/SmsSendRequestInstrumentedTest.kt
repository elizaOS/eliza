/** Tests multipart settlement through real Android PendingIntents and dynamic receivers. */
package ai.eliza.plugins.messages

import android.app.Activity
import android.app.PendingIntent
import android.os.SystemClock
import android.telephony.SmsManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SmsSendRequestInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val requests = mutableListOf<SmsSendRequest>()

    @After
    fun cleanup() {
        instrumentation.runOnMainSync { requests.forEach { it.cancel("test cleanup") } }
    }

    @Test
    fun multipartFailurePreservesFailingCodeAfterSuccessfulFinalPart() {
        val finished = CountDownLatch(1)
        val outcome = AtomicReference<SmsSendRequest.Outcome>()
        val intents = start(2) { outcome.set(it); finished.countDown() }
        intents[0].send(SmsManager.RESULT_ERROR_NO_SERVICE)
        intents[1].send(Activity.RESULT_OK)
        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertEquals(SmsSendRequest.Outcome.Failed(SmsManager.RESULT_ERROR_NO_SERVICE), outcome.get())
        assertThrows(PendingIntent.CanceledException::class.java) { intents[0].send(Activity.RESULT_OK) }
    }

    @Test
    fun repeatedPartDoesNotPrematurelyCompleteMultipartSend() {
        val finished = CountDownLatch(1)
        val count = AtomicInteger()
        val intents = start(2) {
            assertEquals(SmsSendRequest.Outcome.Sent, it)
            count.incrementAndGet()
            finished.countDown()
        }
        intents[0].send(Activity.RESULT_OK)
        intents[0].send(Activity.RESULT_OK)
        assertFalse(finished.await(150, TimeUnit.MILLISECONDS))
        intents[1].send(Activity.RESULT_OK)
        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertEquals(1, count.get())
    }

    @Test
    fun missingReceiptTimesOutOnceAndCancelsPendingIntents() {
        val finished = CountDownLatch(1)
        val count = AtomicInteger()
        val intents = start(1, 100) {
            assertTrue(it is SmsSendRequest.Outcome.Unknown)
            count.incrementAndGet()
            finished.countDown()
        }
        assertTrue(finished.await(2, TimeUnit.SECONDS))
        assertThrows(PendingIntent.CanceledException::class.java) { intents[0].send(Activity.RESULT_OK) }
        instrumentation.runOnMainSync { requests.last().cancel("destroyed") }
        assertEquals(1, count.get())
    }

    @Test
    fun destructionSettlesOnceAndCancelsTheDeadline() {
        val count = AtomicInteger()
        start(1, 100) { assertTrue(it is SmsSendRequest.Outcome.Unknown); count.incrementAndGet() }
        instrumentation.runOnMainSync { requests.last().cancel("destroyed"); requests.last().cancel("destroyed again") }
        SystemClock.sleep(200)
        instrumentation.waitForIdleSync()
        assertEquals(1, count.get())
    }

    @Test
    fun simultaneousRequestsHaveIndependentReceipts() {
        val completed = CountDownLatch(2)
        val first = start(1) { assertEquals(SmsSendRequest.Outcome.Sent, it); completed.countDown() }
        val second = start(1) {
            assertEquals(SmsSendRequest.Outcome.Failed(SmsManager.RESULT_ERROR_RADIO_OFF), it)
            completed.countDown()
        }
        first[0].send(Activity.RESULT_OK)
        second[0].send(SmsManager.RESULT_ERROR_RADIO_OFF)
        assertTrue(completed.await(3, TimeUnit.SECONDS))
    }

    private fun start(parts: Int, timeout: Long = 3000, callback: (SmsSendRequest.Outcome) -> Unit): ArrayList<PendingIntent> {
        lateinit var intents: ArrayList<PendingIntent>
        instrumentation.runOnMainSync {
            val request = SmsSendRequest(instrumentation.targetContext, parts, timeout, callback)
            requests += request
            intents = request.start()
        }
        return intents
    }
}
