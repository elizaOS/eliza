package ai.eliza.plugins.location

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * [Context]-backed reader for the fused current-location fetch that
 * [LocationPlugin.getCurrentPosition] exposes — the accuracy→[Priority] mapping,
 * the [CurrentLocationRequest] construction, and the
 * `FusedLocationProviderClient.getCurrentLocation` call.
 *
 * Extracted from the Capacitor plugin so the real Play Services location path
 * can be exercised by an instrumented `androidTest` (driven with
 * `adb emu geo fix`), without a Capacitor `Bridge`/`Activity`/WebView
 * (issue #9967). The plugin delegates its priority mapping, request build, and
 * async fetch here (JS wire shape unchanged); [awaitCurrentLocation] is the
 * blocking variant the on-device test drives. Requires
 * `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`.
 */
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

    private val fusedClient: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(context.applicationContext)

    /** Accuracy string from JS → Play Services [Priority] constant. */
    fun mapAccuracyToPriority(accuracy: String): Int = when (accuracy) {
        "best", "high" -> Priority.PRIORITY_HIGH_ACCURACY
        "medium" -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
        "low" -> Priority.PRIORITY_LOW_POWER
        "passive" -> Priority.PRIORITY_PASSIVE
        else -> Priority.PRIORITY_HIGH_ACCURACY
    }

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

    fun readBackgroundPermissionStatus(foregroundStatus: String): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return foregroundStatus

        val backgroundGranted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED

        return when {
            backgroundGranted -> "granted"
            foregroundStatus != "granted" -> "denied"
            else -> "prompt"
        }
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

    /** The fresh-fix request the plugin's `requestFreshLocation` issues. */
    fun buildCurrentLocationRequest(priority: Int, timeoutMs: Long, maxAgeMs: Long): CurrentLocationRequest =
        CurrentLocationRequest.Builder()
            .setPriority(priority)
            .setMaxUpdateAgeMillis(maxAgeMs)
            .setDurationMillis(timeoutMs)
            .build()

    /** The async fused fetch the plugin awaits via its success/failure listeners. */
    fun getCurrentLocation(request: CurrentLocationRequest): Task<Location> =
        fusedClient.getCurrentLocation(request, null)

    /**
     * Blocking current-location fetch for tests and synchronous callers: issues
     * the same fused [getCurrentLocation] the plugin uses and awaits the Task.
     * Returns `null` when no fix arrives within the window.
     *
     * @throws com.google.android.gms.tasks.RuntimeExecutionException on a Play
     *   Services failure, [java.util.concurrent.TimeoutException] if the Task
     *   never completes.
     */
    fun awaitCurrentLocation(accuracy: String, timeoutMs: Long, maxAgeMs: Long = 0): Location? {
        val request = buildCurrentLocationRequest(mapAccuracyToPriority(accuracy), timeoutMs, maxAgeMs)
        return Tasks.await(getCurrentLocation(request), timeoutMs + 2000, TimeUnit.MILLISECONDS)
    }

    /** The continuous-updates request the plugin's `watchPositionInternal` builds. */
    fun buildLocationRequest(priority: Int, intervalMs: Long): LocationRequest =
        LocationRequest.Builder(priority, intervalMs).build()

    /**
     * Blocking single-update fetch via `requestLocationUpdates` — the same
     * continuous API the plugin's `watchPosition` uses — keeping the provider
     * actively warm until the first fix arrives (or [timeoutMs] elapses). This
     * is the path that an emulator's injected `geo fix` actually delivers on,
     * since the provider stays active. Returns `null` on timeout.
     */
    fun awaitNextLocation(accuracy: String, timeoutMs: Long, intervalMs: Long = 1000): Location? {
        val request = buildLocationRequest(mapAccuracyToPriority(accuracy), intervalMs)
        val holder = AtomicReference<Location?>(null)
        val latch = CountDownLatch(1)
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val location = result.lastLocation ?: return
                holder.set(location)
                latch.countDown()
            }
        }
        fusedClient.requestLocationUpdates(request, callback, Looper.getMainLooper())
        try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } finally {
            fusedClient.removeLocationUpdates(callback)
        }
        return holder.get()
    }
}
