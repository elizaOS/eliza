/**
 * Reads Android framework locations without requiring Google Play Services.
 * Registration and cancellation run on the main looper; each one-shot request
 * owns its timeout and listener, and cached fixes use monotonic age.
 */
package ai.eliza.plugins.location

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class LocationFixReader(private val context: Context) {
    data class ProviderStatus(
        val gpsEnabled: Boolean,
        val networkEnabled: Boolean,
        val passiveEnabled: Boolean,
        val enabledProviders: List<String>,
    )

    data class Coordinates(
        val latitude: Double,
        val longitude: Double,
        val altitude: Double?,
        val accuracy: Double,
        val altitudeAccuracy: Double?,
        val speed: Double?,
        val heading: Double?,
        val timestamp: Long,
    )

    data class PositionResult(
        val coords: Coordinates,
        val cached: Boolean,
    )

    fun hasForegroundPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ) == PackageManager.PERMISSION_GRANTED

    /**
     * Tri-state foreground status matching the JS `LocationPermissionStatus`
     * contract (`granted | denied | prompt`). A never-requested permission must
     * report `prompt` (not `denied`) so the app shows the OS prompt instead of
     * deep-linking to settings. `checkSelfPermission` alone cannot tell
     * never-asked from denied, so — like the iOS `.notDetermined` mapping —
     * we use [ActivityCompat.shouldShowRequestPermissionRationale]: it is `true`
     * only after the user actively denied a prior request, so `rationale==true`
     * on an ungranted permission is `denied`, otherwise `prompt`. (Like
     * Capacitor's own default, an `Activity`-only read cannot tell a fresh
     * never-asked permission from a permanent "don't ask again" deny — both
     * yield `rationale==false` → `prompt`; Capacitor disambiguates the latter
     * with a "has-been-requested" preference. The contract that matters here —
     * a never-asked permission must report `prompt`, never `denied` — holds.)
     * Needs an [Activity] (the rationale check is Activity-scoped); the
     * production JS field still comes from Capacitor's
     * `getPermissionState("location")`.
     */
    fun readForegroundPermissionStatus(activity: Activity): String {
        if (hasForegroundPermission()) return "granted"

        val shouldShowRationale =
            ActivityCompat.shouldShowRequestPermissionRationale(
                activity,
                Manifest.permission.ACCESS_FINE_LOCATION,
            ) ||
                ActivityCompat.shouldShowRequestPermissionRationale(
                    activity,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                )

        return if (shouldShowRationale) "denied" else "prompt"
    }

    fun readProviderStatus(): ProviderStatus {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val enabledProviders = manager.getProviders(true).sorted()
        return ProviderStatus(
            gpsEnabled = LocationManager.GPS_PROVIDER in enabledProviders,
            networkEnabled = LocationManager.NETWORK_PROVIDER in enabledProviders,
            passiveEnabled = LocationManager.PASSIVE_PROVIDER in enabledProviders,
            enabledProviders = enabledProviders,
        )
    }

    fun buildPositionResult(location: Location, cached: Boolean): PositionResult =
        PositionResult(
            coords = Coordinates(
                latitude = location.latitude,
                longitude = location.longitude,
                altitude = if (location.hasAltitude()) location.altitude else null,
                accuracy = location.accuracy.toDouble(),
                altitudeAccuracy = if (
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    location.hasVerticalAccuracy()
                ) {
                    location.verticalAccuracyMeters.toDouble()
                } else {
                    null
                },
                speed = if (location.hasSpeed()) location.speed.toDouble() else null,
                heading = if (location.hasBearing()) location.bearing.toDouble() else null,
                timestamp = location.time,
            ),
            cached = cached,
        )

    private val manager: LocationManager
        get() = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: throw IllegalStateException("Location service is unavailable")

    private val handler = Handler(Looper.getMainLooper())

    class RequestHandle(private val cleanup: () -> Unit) {
        private var active = true

        fun cancel() {
            check(Looper.myLooper() == Looper.getMainLooper())
            if (!active) return
            active = false
            cleanup()
        }
    }

    private fun selectProvider(accuracy: String): String {
        require(accuracy in setOf("best", "high", "medium", "low", "passive")) {
            "accuracy must be best, high, medium, low, or passive"
        }
        val fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val candidates = when {
            accuracy == "passive" -> listOf(LocationManager.PASSIVE_PROVIDER)
            !fine -> listOf(LocationManager.NETWORK_PROVIDER, "fused")
            accuracy == "best" || accuracy == "high" ->
                listOf(LocationManager.GPS_PROVIDER, "fused", LocationManager.NETWORK_PROVIDER)
            else -> listOf(LocationManager.NETWORK_PROVIDER, "fused", LocationManager.GPS_PROVIDER)
        }
        val enabled = manager.getProviders(true)
        return candidates.firstOrNull { it in enabled }
            ?: throw IllegalStateException("No enabled location provider supports the requested accuracy and permission")
    }

    fun watchPosition(
        accuracy: String,
        intervalMs: Long,
        distanceMeters: Float,
        onLocation: (Location) -> Unit,
        onUnavailable: (String) -> Unit,
    ): RequestHandle {
        check(Looper.myLooper() == Looper.getMainLooper())
        require(intervalMs >= 0) { "minInterval must be non-negative" }
        require(distanceMeters.isFinite() && distanceMeters >= 0) { "minDistance must be non-negative and finite" }
        val provider = selectProvider(accuracy)
        var active = true
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                if (active) onLocation(location)
            }
            override fun onProviderDisabled(provider: String) {
                if (active) onUnavailable("Location provider $provider was disabled")
            }
            override fun onProviderEnabled(provider: String) = Unit
            @Deprecated("Required on older Android releases")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
        }
        manager.requestLocationUpdates(provider, intervalMs, distanceMeters, listener, Looper.getMainLooper())
        return RequestHandle {
            active = false
            manager.removeUpdates(listener)
        }
    }

    fun getCurrentPosition(
        accuracy: String,
        timeoutMs: Long,
        maxAgeMs: Long,
        onLocation: (Location, Boolean) -> Unit,
        onError: (String, String) -> Unit,
    ): RequestHandle {
        check(Looper.myLooper() == Looper.getMainLooper())
        require(timeoutMs > 0) { "timeout must be positive" }
        require(maxAgeMs >= 0) { "maxAge must be non-negative" }
        val provider = selectProvider(accuracy)
        if (maxAgeMs > 0) {
            val cached = manager.getLastKnownLocation(provider)
            if (cached != null) {
                val ageNanos = SystemClock.elapsedRealtimeNanos() - cached.elapsedRealtimeNanos
                if (ageNanos >= 0 && ageNanos / 1_000_000 <= maxAgeMs) {
                    onLocation(cached, true)
                    return RequestHandle { }
                }
            }
        }
        var settled = false
        lateinit var subscription: RequestHandle
        lateinit var timeout: Runnable
        fun finish() {
            settled = true
            handler.removeCallbacks(timeout)
            subscription.cancel()
        }
        timeout = Runnable {
            if (!settled) {
                finish()
                onError("TIMEOUT", "Location request timed out")
            }
        }
        subscription = watchPosition(accuracy, 0, 0f, { location ->
            if (!settled) {
                finish()
                onLocation(location, false)
            }
        }, { message ->
            if (!settled) {
                finish()
                onError("POSITION_UNAVAILABLE", message)
            }
        })
        handler.postDelayed(timeout, timeoutMs)
        return RequestHandle {
            if (!settled) finish()
        }
    }
}
