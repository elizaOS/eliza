package ai.milaidy.plugins.location

import android.Manifest
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.Looper
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.android.gms.location.*
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * MilaidyLocation Capacitor Plugin
 *
 * Provides location services using Google Play Services FusedLocationProviderClient.
 * Supports one-shot position, continuous watching, maxAge caching, and background location.
 */
@CapacitorPlugin(
    name = "MilaidyLocation",
    permissions = [
        Permission(alias = "location", strings = [
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ]),
        Permission(alias = "background", strings = [
            Manifest.permission.ACCESS_BACKGROUND_LOCATION
        ])
    ]
)
class LocationPlugin : Plugin() {

    private var fusedLocationClient: FusedLocationProviderClient? = null
    private val watches = ConcurrentHashMap<String, LocationCallback>()
    private var pendingCall: PluginCall? = null
    private var pendingAction: String? = null

    // Cache the last known location for maxAge support
    private var lastKnownLocation: Location? = null

    override fun load() {
        super.load()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(activity)
    }

    // ── getCurrentPosition ──────────────────────────────────────────────

    @PluginMethod
    fun getCurrentPosition(call: PluginCall) {
        if (!hasRequiredPermissions()) {
            pendingCall = call
            pendingAction = "getCurrentPosition"
            requestAllPermissions(call, "handlePermissionResult")
            return
        }
        getCurrentPositionInternal(call)
    }

    private fun getCurrentPositionInternal(call: PluginCall) {
        val accuracy = call.getString("accuracy") ?: "high"
        val timeout = call.getDouble("timeout") ?: 10000.0
        val maxAge = call.getDouble("maxAge") ?: 0.0
        val priority = mapAccuracyToPriority(accuracy)

        // maxAge > 0: try returning cached location if fresh enough (mirrors classic bestLastKnown)
        if (maxAge > 0) {
            try {
                fusedLocationClient?.lastLocation?.addOnSuccessListener { cached ->
                    if (cached != null) {
                        val age = System.currentTimeMillis() - cached.time
                        if (age <= maxAge.toLong()) {
                            lastKnownLocation = cached
                            call.resolve(buildLocationResult(cached, cached = true))
                            return@addOnSuccessListener
                        }
                    }
                    // Cache miss — fall through to a fresh fix
                    requestFreshLocation(call, priority, timeout, maxAge)
                }?.addOnFailureListener {
                    requestFreshLocation(call, priority, timeout, maxAge)
                }
                return
            } catch (_: SecurityException) {
                // Permission lost between check and call — fall through
            }
        }

        requestFreshLocation(call, priority, timeout, maxAge)
    }

    /** Request a fresh location using CurrentLocationRequest. */
    private fun requestFreshLocation(call: PluginCall, priority: Int, timeout: Double, maxAge: Double) {
        val request = CurrentLocationRequest.Builder()
            .setPriority(priority)
            .setMaxUpdateAgeMillis(maxAge.toLong())
            .setDurationMillis(timeout.toLong())
            .build()

        try {
            fusedLocationClient?.getCurrentLocation(request, null)
                ?.addOnSuccessListener { location ->
                    if (location != null) {
                        lastKnownLocation = location
                        call.resolve(buildLocationResult(location, cached = false))
                    } else {
                        val err = buildErrorEvent("POSITION_UNAVAILABLE", "Unable to get location")
                        notifyListeners("error", err)
                        call.reject("Unable to get location")
                    }
                }
                ?.addOnFailureListener { e ->
                    val code = if (e is SecurityException) "PERMISSION_DENIED" else "POSITION_UNAVAILABLE"
                    val err = buildErrorEvent(code, "Location error: ${e.message}")
                    notifyListeners("error", err)
                    call.reject("Location error: ${e.message}")
                }
        } catch (e: SecurityException) {
            val err = buildErrorEvent("PERMISSION_DENIED", "Location permission required")
            notifyListeners("error", err)
            call.reject("Location permission required")
        }
    }

    // ── watchPosition ───────────────────────────────────────────────────

    @PluginMethod
    fun watchPosition(call: PluginCall) {
        if (!hasRequiredPermissions()) {
            pendingCall = call
            pendingAction = "watchPosition"
            requestAllPermissions(call, "handlePermissionResult")
            return
        }
        watchPositionInternal(call)
    }

    private fun watchPositionInternal(call: PluginCall) {
        val accuracy = call.getString("accuracy") ?: "high"
        val minInterval = call.getDouble("minInterval") ?: 0.0
        val minDistance = call.getDouble("minDistance") ?: 0.0
        val priority = mapAccuracyToPriority(accuracy)

        val watchId = UUID.randomUUID().toString()

        val request = LocationRequest.Builder(priority, minInterval.toLong())
            .setMinUpdateDistanceMeters(minDistance.toFloat())
            .build()

        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                for (location in result.locations) {
                    lastKnownLocation = location
                    notifyListeners("locationChange", buildLocationResult(location, cached = false))
                }
            }

            override fun onLocationAvailability(availability: LocationAvailability) {
                if (!availability.isLocationAvailable) {
                    notifyListeners("error", buildErrorEvent(
                        "POSITION_UNAVAILABLE",
                        "Location services became unavailable"
                    ))
                }
            }
        }

        try {
            fusedLocationClient?.requestLocationUpdates(
                request,
                callback,
                Looper.getMainLooper()
            )

            watches[watchId] = callback
            call.resolve(JSObject().apply {
                put("watchId", watchId)
            })
        } catch (e: SecurityException) {
            notifyListeners("error", buildErrorEvent("PERMISSION_DENIED", "Location permission required"))
            call.reject("Location permission required")
        }
    }

    // ── clearWatch ──────────────────────────────────────────────────────

    @PluginMethod
    fun clearWatch(call: PluginCall) {
        val watchId = call.getString("watchId")
        if (watchId == null) {
            call.reject("Missing watchId")
            return
        }

        val callback = watches.remove(watchId)
        if (callback != null) {
            fusedLocationClient?.removeLocationUpdates(callback)
        }
        call.resolve()
    }

    // ── Permissions ─────────────────────────────────────────────────────

    @PluginMethod
    fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    fun requestPermissions(call: PluginCall) {
        if (hasRequiredPermissions()) {
            call.resolve(buildPermissionResult())
            return
        }
        pendingAction = "requestPermissions"
        requestAllPermissions(call, "handlePermissionResult")
    }

    @PermissionCallback
    private fun handlePermissionResult(call: PluginCall) {
        if (hasRequiredPermissions()) {
            when (pendingAction) {
                "getCurrentPosition" -> {
                    pendingAction = null
                    pendingCall = null
                    getCurrentPositionInternal(call)
                }
                "watchPosition" -> {
                    pendingAction = null
                    pendingCall = null
                    watchPositionInternal(call)
                }
                else -> {
                    pendingAction = null
                    pendingCall = null
                    call.resolve(buildPermissionResult())
                }
            }
        } else {
            pendingAction = null
            pendingCall = null
            notifyListeners("error", buildErrorEvent("PERMISSION_DENIED", "Location permission denied"))
            call.reject("Location permission denied")
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun hasRequiredPermissions(): Boolean {
        return getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED
    }

    /** Map accuracy string from JS to Play Services Priority constant. */
    private fun mapAccuracyToPriority(accuracy: String): Int {
        return when (accuracy) {
            "best" -> Priority.PRIORITY_HIGH_ACCURACY
            "high" -> Priority.PRIORITY_HIGH_ACCURACY
            "medium" -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
            "low" -> Priority.PRIORITY_LOW_POWER
            "passive" -> Priority.PRIORITY_PASSIVE
            else -> Priority.PRIORITY_HIGH_ACCURACY
        }
    }

    private fun buildPermissionResult(): JSObject {
        val locationState = getPermissionState("location")
        val locationStatus = when (locationState) {
            com.getcapacitor.PermissionState.GRANTED -> "granted"
            com.getcapacitor.PermissionState.DENIED -> "denied"
            else -> "prompt"
        }

        val result = JSObject().apply {
            put("location", locationStatus)
        }

        // Background location is a separate permission on Android 10+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val bgGranted = ContextCompat.checkSelfPermission(
                context, Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) == PackageManager.PERMISSION_GRANTED

            val bgStatus = when {
                bgGranted -> "granted"
                // If foreground isn't granted, background is implicitly denied
                locationStatus != "granted" -> "denied"
                else -> "prompt"
            }
            result.put("background", bgStatus)
        } else {
            // Pre-Q: background is granted with foreground
            result.put("background", locationStatus)
        }

        return result
    }

    private fun buildLocationResult(location: Location, cached: Boolean): JSObject {
        val coords = JSObject().apply {
            put("latitude", location.latitude)
            put("longitude", location.longitude)
            if (location.hasAltitude()) {
                put("altitude", location.altitude)
            }
            put("accuracy", location.accuracy.toDouble())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasVerticalAccuracy()) {
                put("altitudeAccuracy", location.verticalAccuracyMeters.toDouble())
            }
            if (location.hasSpeed()) {
                put("speed", location.speed.toDouble())
            }
            if (location.hasBearing()) {
                put("heading", location.bearing.toDouble())
            }
            put("timestamp", location.time)
        }

        return JSObject().apply {
            put("coords", coords)
            put("cached", cached)
        }
    }

    private fun buildErrorEvent(code: String, message: String): JSObject {
        return JSObject().apply {
            put("code", code)
            put("message", message)
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        for ((_, callback) in watches) {
            fusedLocationClient?.removeLocationUpdates(callback)
        }
        watches.clear()
    }
}
