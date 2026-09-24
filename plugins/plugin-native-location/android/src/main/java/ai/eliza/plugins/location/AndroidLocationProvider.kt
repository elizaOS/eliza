package ai.eliza.plugins.location

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Android framework location for AOSP devices without Google Play Services. */
internal class AndroidLocationProvider(context: Context) : Closeable {
    private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val handler = Handler(Looper.getMainLooper())
    private val active = ConcurrentHashMap.newKeySet<Closeable>()

    private fun providers(priority: Int): List<String> {
        val enabled = manager.getProviders(true)
        val candidates = if (priority == Priority.PRIORITY_PASSIVE) {
            listOf(LocationManager.PASSIVE_PROVIDER)
        } else if (priority == Priority.PRIORITY_LOW_POWER) {
            listOf(LocationManager.NETWORK_PROVIDER)
        } else {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        }
        return candidates.filter { it in enabled }.ifEmpty {
            // Low-power requests may use GPS when the device has no network provider.
            if (priority == Priority.PRIORITY_LOW_POWER && LocationManager.GPS_PROVIDER in enabled) {
                listOf(LocationManager.GPS_PROVIDER)
            } else emptyList()
        }
    }

    fun lastLocation(priority: Int): Location? = providers(priority)
        .mapNotNull { manager.getLastKnownLocation(it) }
        .maxByOrNull { it.elapsedRealtimeNanos }

    fun watch(priority: Int, intervalMs: Long, distance: Float, onLocation: (Location) -> Unit, onError: (Exception) -> Unit): Closeable {
        val available = providers(priority)
        check(available.isNotEmpty()) { "No enabled Android location provider" }
        val closed = AtomicBoolean(false)
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) { if (!closed.get()) onLocation(location) }
            override fun onProviderDisabled(provider: String) {
                if (!closed.get()) onError(IllegalStateException("Location provider disabled: $provider"))
            }
            override fun onProviderEnabled(provider: String) {}
            @Deprecated("Legacy Android callback")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        }
        lateinit var subscription: Closeable
        subscription = Closeable {
            if (closed.compareAndSet(false, true)) {
                manager.removeUpdates(listener)
                active.remove(subscription)
            }
        }
        active.add(subscription)
        try {
            for (provider in available) manager.requestLocationUpdates(provider, intervalMs, distance, listener, Looper.getMainLooper())
        } catch (error: Exception) {
            subscription.close()
            throw error
        }
        return subscription
    }

    fun current(priority: Int, timeoutMs: Long, maxAgeMs: Long): Task<Location> {
        val result = TaskCompletionSource<Location>()
        val done = AtomicBoolean(false)
        var subscription: Closeable? = null
        var timer: Runnable? = null
        lateinit var request: Closeable
        fun finish(location: Location?, error: Exception?) {
            if (!done.compareAndSet(false, true)) return
            timer?.let(handler::removeCallbacks)
            subscription?.close()
            active.remove(request)
            if (error != null) result.setException(error) else result.setResult(location)
        }
        request = Closeable { finish(null, IllegalStateException("Location request cancelled")) }
        active.add(request)
        // Serialize setup, callbacks and timeout on the main looper. In particular,
        // close cannot race a callback before the subscription is assigned.
        handler.post {
            if (done.get()) return@post
            try {
                val cached = if (maxAgeMs > 0) lastLocation(priority) else null
                val age = cached?.let { (SystemClock.elapsedRealtimeNanos() - it.elapsedRealtimeNanos) / 1_000_000 }
                if (cached != null && age != null && age in 0..maxAgeMs) {
                    finish(cached, null)
                    return@post
                }
                subscription = watch(priority, 0, 0f, { finish(it, null) }, { finish(null, it) })
                timer = Runnable { finish(null, null) }.also { handler.postDelayed(it, timeoutMs) }
            } catch (error: Exception) {
                finish(null, error)
            }
        }
        return result.task
    }

    override fun close() {
        handler.post { active.toList().forEach { it.close() } }
    }
}
