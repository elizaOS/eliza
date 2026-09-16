package ai.eliza.plugins.location

import android.Manifest
import android.location.Location
import android.os.Looper
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
 * ElizaLocation Capacitor Plugin
 *
 * Provides location services using Google Play Services FusedLocationProviderClient.
 * Supports foreground one-shot position, continuous watching, and maxAge caching.
 */
@CapacitorPlugin(
    name = "ElizaLocation",
    permissions = [
        Permission(alias = "location", strings = [
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ])
    ]
)
class LocationPlugin : Plugin() {

    private var fusedLocationClient: FusedLocationProviderClient? = null
    private val watches = ConcurrentHashMap<String, LocationCallback>()
    private val pendingActions = ConcurrentHashMap<String, String>()

    // Cache the last known location for maxAge support
    private var lastKnownLocation: Location? = null

    // The fused current-location fetch (priority map + request build + getCurrentLocation)
    // lives in LocationFixReader so it is exercisable by an instrumented androidTest
    // without an Activity/Bridge (issue #9967). The watch path keeps its own client.
    private val reader by lazy { LocationFixReader(context) }

    override fun load() {
        super.load()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(activity)
    }

    // ── getCurrentPosition ──────────────────────────────────────────────

    @PluginMethod
    fun getCurrentPosition(call: PluginCall) {
        if (!hasRequiredPermissions()) {
            pendingActions[call.callbackId] = "getCurrentPosition"
            requestPermissionForAlias("location", call, "handlePermissionResult")
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
        val request = reader.buildCurrentLocationRequest(priority, timeout.toLong(), maxAge.toLong())

        try {
            reader.getCurrentLocation(request)
                .addOnSuccessListener { location ->
                    if (location != null) {
                        lastKnownLocation = location
                        call.resolve(buildLocationResult(location, cached = false))
                    } else {
                        val err = buildErrorEvent("POSITION_UNAVAILABLE", "Unable to get location")
                        notifyListeners("error", err)
                        call.reject("Unable to get location")
                    }
                }
                .addOnFailureListener { e ->
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
            pendingActions[call.callbackId] = "watchPosition"
            requestPermissionForAlias("location", call, "handlePermissionResult")
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
    override fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        if (hasRequiredPermissions()) {
            call.resolve(buildPermissionResult())
            return
        }
        pendingActions[call.callbackId] = "requestPermissions"
        requestPermissionForAlias("location", call, "handlePermissionResult")
    }

    @PermissionCallback
    private fun handlePermissionResult(call: PluginCall) {
        val pendingAction = pendingActions.remove(call.callbackId)
        if (hasRequiredPermissions()) {
            when (pendingAction) {
                "getCurrentPosition" -> {
                    getCurrentPositionInternal(call)
                }
                "watchPosition" -> {
                    watchPositionInternal(call)
                }
                else -> {
                    call.resolve(buildPermissionResult())
                }
            }
        } else {
            notifyListeners("error", buildErrorEvent("PERMISSION_DENIED", "Location permission denied"))
            if (pendingAction == "requestPermissions") {
                call.resolve(buildPermissionResult())
            } else {
                call.reject("Location permission denied")
            }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    override fun hasRequiredPermissions(): Boolean {
        // Android's approximate-location choice grants COARSE while denying
        // FINE. Either grant is sufficient for every foreground read path.
        return reader.hasForegroundPermission()
    }

    /** Map accuracy string from JS to Play Services Priority constant. */
    private fun mapAccuracyToPriority(accuracy: String): Int = reader.mapAccuracyToPriority(accuracy)

    private fun buildPermissionResult(): JSObject {
        val locationStatus = if (reader.hasForegroundPermission()) {
            "granted"
        } else {
            when (getPermissionState("location")) {
                com.getcapacitor.PermissionState.DENIED -> "denied"
                else -> "prompt"
            }
        }
        val accuracy = when {
            androidx.core.content.ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.ACCESS_FINE_LOCATION,
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED -> "precise"
            reader.hasForegroundPermission() -> "approximate"
            else -> "none"
        }

        return JSObject().apply {
            put("location", locationStatus)
            put("accuracy", accuracy)
        }
    }

    private fun buildLocationResult(location: Location, cached: Boolean): JSObject {
        val position = reader.buildPositionResult(location, cached)
        val coordsData = position.coords
        val coords = JSObject().apply {
            put("latitude", coordsData.latitude)
            put("longitude", coordsData.longitude)
            coordsData.altitude?.let {
                put("altitude", it)
            }
            put("accuracy", coordsData.accuracy)
            coordsData.altitudeAccuracy?.let {
                put("altitudeAccuracy", it)
            }
            coordsData.speed?.let {
                put("speed", it)
            }
            coordsData.heading?.let {
                put("heading", it)
            }
            put("timestamp", coordsData.timestamp)
        }

        return JSObject().apply {
            put("coords", coords)
            put("cached", position.cached)
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
