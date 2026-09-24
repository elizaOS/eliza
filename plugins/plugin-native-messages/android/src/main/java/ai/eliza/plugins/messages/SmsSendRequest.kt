/**
 * Owns multipart SMS sent receipts, timeout and receiver cleanup on the main looper.
 * A missing receipt means unknown send status, never permission to retry a send.
 */
package ai.eliza.plugins.messages

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.UUID

internal class SmsSendRequest(
    private val context: Context,
    private val partCount: Int,
    private val timeoutMs: Long = 60_000,
    private val onFinished: (Outcome) -> Unit,
) {
    sealed class Outcome {
        object Sent : Outcome()
        data class Failed(val resultCode: Int) : Outcome()
        data class Unknown(val reason: String) : Outcome()
    }

    private val action = "${context.packageName}.ELIZA_SMS_SENT.${UUID.randomUUID()}"
    private val handler = Handler(Looper.getMainLooper())
    private val pending = mutableListOf<PendingIntent>()
    private val received = mutableSetOf<Int>()
    private var failureCode: Int? = null
    private var registered = false
    private var started = false
    private var settled = false
    private val timeout = Runnable { finish(Outcome.Unknown("SMS sent confirmation timed out; send status is unknown")) }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context, intent: Intent) {
            if (settled || intent.action != action) return
            val part = intent.getIntExtra("part", -1)
            if (part !in 0 until partCount || !received.add(part)) return
            if (resultCode != Activity.RESULT_OK && failureCode == null) failureCode = resultCode
            if (received.size == partCount) {
                finish(failureCode?.let { Outcome.Failed(it) } ?: Outcome.Sent)
            }
        }
    }

    fun start(): ArrayList<PendingIntent> {
        check(Looper.myLooper() == Looper.getMainLooper())
        check(!started && !settled) { "SMS request has already started or settled" }
        require(partCount > 0 && timeoutMs > 0)
        started = true
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
            } else {
                context.registerReceiver(receiver, IntentFilter(action))
            }
            registered = true
            for (part in 0 until partCount) {
                pending += PendingIntent.getBroadcast(context, part,
                    Intent(action).setPackage(context.packageName).putExtra("part", part),
                    PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            handler.postDelayed(timeout, timeoutMs)
            return ArrayList(pending)
        } catch (error: RuntimeException) {
            // error-policy:J2 Release partially registered resources; the plugin translates the original error.
            cleanup()
            throw error
        }
    }

    fun cancel(reason: String) = finish(Outcome.Unknown(reason))

    private fun finish(outcome: Outcome) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (settled) return
        settled = true
        cleanup()
        onFinished(outcome)
    }

    private fun cleanup() {
        handler.removeCallbacks(timeout)
        if (registered) {
            registered = false
            context.unregisterReceiver(receiver)
        }
        pending.forEach { it.cancel() }
        pending.clear()
    }
}
