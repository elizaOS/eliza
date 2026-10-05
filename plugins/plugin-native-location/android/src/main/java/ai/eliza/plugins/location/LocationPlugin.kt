/**
 * Exposes foreground Android framework location reads and watches to Capacitor.
 * Each native request owns cancellation, permission errors and its completion;
 * all lifecycle state is confined to the main looper.
 */
package ai.eliza.plugins.location

import android.Manifest
import android.location.Location
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.UUID

@CapacitorPlugin(
    name = "ElizaLocation",
    permissions = [Permission(alias = "location", strings = [
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    ])],
)
class LocationPlugin : Plugin() {
    private val reader by lazy { LocationFixReader(context) }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val watches = mutableMapOf<String, LocationFixReader.RequestHandle>()
    private val requests = mutableMapOf<String, Pair<PluginCall, LocationFixReader.RequestHandle>>()
    private val pendingActions = mutableMapOf<String, Pair<String, PluginCall>>()
    private var destroyed = false

    @PluginMethod
    fun getCurrentPosition(call: PluginCall) = runLocationCall(call) {
        if (!hasRequiredPermissions()) {
            pendingActions[call.callbackId] = "getCurrentPosition" to call
            requestPermissionForAlias("location", call, "handlePermissionResult")
            return@runLocationCall
        }
        getCurrentPositionInternal(call)
    }

    private fun getCurrentPositionInternal(call: PluginCall) = runLocationCall(call) {
        val timeout = duration(call, "timeout", 10000.0, positive = true)
        val maxAge = duration(call, "maxAge", 0.0)
        var completed = false
        val request = reader.getCurrentPosition(call.getString("accuracy") ?: "high", timeout, maxAge,
            { location, cached ->
                completed = true
                requests.remove(call.callbackId)
                call.resolve(buildLocationResult(location, cached))
            },
            { code, message ->
                completed = true
                requests.remove(call.callbackId)
                rejectLocation(call, code, message)
            },
        )
        if (!completed) requests[call.callbackId] = call to request
    }

    @PluginMethod
    fun watchPosition(call: PluginCall) = runLocationCall(call) {
        if (!hasRequiredPermissions()) {
            pendingActions[call.callbackId] = "watchPosition" to call
            requestPermissionForAlias("location", call, "handlePermissionResult")
            return@runLocationCall
        }
        watchPositionInternal(call)
    }

    private fun watchPositionInternal(call: PluginCall) = runLocationCall(call) {
        val interval = duration(call, "minInterval", 0.0)
        val distance = number(call, "minDistance", 0.0)
        require(distance.isFinite() && distance >= 0 && distance <= Float.MAX_VALUE) {
            "minDistance must be non-negative and finite"
        }
        val watchId = UUID.randomUUID().toString()
        val request = reader.watchPosition(call.getString("accuracy") ?: "high", interval, distance.toFloat(),
            { location -> notifyListeners("locationChange", buildLocationResult(location, false)) },
            { message -> notifyListeners("error", buildErrorEvent("POSITION_UNAVAILABLE", message)) },
        )
        watches[watchId] = request
        call.resolve(JSObject().apply { put("watchId", watchId) })
    }

    @PluginMethod
    fun clearWatch(call: PluginCall) = runLocationCall(call) {
        val watchId = call.getString("watchId")
        require(!watchId.isNullOrBlank()) { "Missing watchId" }
        watches.remove(watchId)?.cancel()
        call.resolve()
    }

    private fun number(call: PluginCall, name: String, default: Double): Double {
        if (!call.data.has(name)) return default
        val value = call.data.opt(name)
        require(value is Number) { "$name must be a number" }
        return value.toDouble()
    }

    private fun duration(call: PluginCall, name: String, default: Double, positive: Boolean = false): Long {
        val value = number(call, name, default)
        require(value.isFinite() && value >= (if (positive) 1.0 else 0.0) && value < Long.MAX_VALUE.toDouble()) {
            "$name must be ${if (positive) "positive" else "non-negative"} finite milliseconds"
        }
        return value.toLong()
    }

    private fun runLocationCall(call: PluginCall, operation: () -> Unit) {
        mainHandler.post {
            if (destroyed) {
                call.reject("Location plugin was destroyed", "CANCELLED")
                return@post
            }
            try {
                operation()
            } catch (error: SecurityException) {
                // error-policy:J1 Permission may be revoked between admission and framework access.
                rejectLocation(call, "PERMISSION_DENIED", "Location permission required")
            } catch (error: IllegalArgumentException) {
                // error-policy:J3 Malformed options reject without fabricating a location.
                call.reject(error.message, "INVALID_ARGUMENT", error)
            } catch (error: IllegalStateException) {
                // error-policy:J1 Missing or disabled framework providers become an explicit bridge error.
                rejectLocation(call, "POSITION_UNAVAILABLE", error.message ?: "Location service unavailable")
            }
        }
    }

    private fun rejectLocation(call: PluginCall, code: String, message: String) {
        notifyListeners("error", buildErrorEvent(code, message))
        call.reject(message, code)
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) = runLocationCall(call) {
        if (hasRequiredPermissions()) {
            call.resolve(buildPermissionResult())
            return@runLocationCall
        }
        pendingActions[call.callbackId] = "requestPermissions" to call
        requestPermissionForAlias("location", call, "handlePermissionResult")
    }

    @PermissionCallback
    private fun handlePermissionResult(call: PluginCall) {
        val pendingAction = pendingActions.remove(call.callbackId)?.first ?: return
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

    override fun hasRequiredPermissions(): Boolean {
        // Android's approximate-location choice grants COARSE while denying
        // FINE. Either grant is sufficient for every foreground read path.
        return reader.hasForegroundPermission()
    }

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

    override fun handleOnDestroy() {
        destroyed = true
        for ((call, request) in requests.values) {
            request.cancel()
            call.reject("Location request cancelled because the plugin was destroyed", "CANCELLED")
        }
        requests.clear()
        for (request in watches.values) request.cancel()
        watches.clear()
        pendingActions.values.forEach { (_, call) -> call.reject("Location plugin was destroyed", "CANCELLED") }
        pendingActions.clear()
        super.handleOnDestroy()
    }
}
