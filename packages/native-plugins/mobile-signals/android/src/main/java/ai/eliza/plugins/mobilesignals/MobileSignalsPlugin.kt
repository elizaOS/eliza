package ai.eliza.plugins.mobilesignals

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import org.json.JSONObject

private const val HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata"

@CapacitorPlugin(name = "MobileSignals")
class MobileSignalsPlugin : Plugin() {
    private val tag = "MobileSignalsPlugin"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val permissionRequest = PermissionController.createRequestPermissionResultContract()
    private var monitoring = false
    private var receiver: BroadcastReceiver? = null

    @PluginMethod
    fun startMonitoring(call: PluginCall) {
        if (monitoring) {
            call.resolve(buildStartResult())
            return
        }

        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val action = intent.action ?: return
                if (!monitoring) return
                emitSignal("broadcast:$action")
                if (
                    action == Intent.ACTION_SCREEN_ON ||
                    action == Intent.ACTION_SCREEN_OFF ||
                    action == Intent.ACTION_USER_PRESENT
                ) {
                    emitHealthSignal(action)
                }
            }
        }

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
            }
        }

        try {
            context.registerReceiver(receiver, filter)
            monitoring = true
            call.resolve(buildStartResult())
            if (call.getBoolean("emitInitial") ?: true) {
                emitSignal("start")
                emitHealthSignal("start")
            }
        } catch (error: Throwable) {
            Log.e(tag, "Failed to start monitoring", error)
            call.reject("Failed to start monitoring: ${error.message}")
        }
    }

    @PluginMethod
    fun stopMonitoring(call: PluginCall) {
        stopInternal()
        call.resolve(JSObject().apply {
            put("stopped", true)
        })
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        scope.launch {
            call.resolve(resolvePermissionResult())
        }
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        val sdkStatus = HealthConnectClient.getSdkStatus(context, HEALTH_CONNECT_PACKAGE)
        if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
            call.resolve(buildPermissionResult(sdkStatus))
            return
        }

        val activity = activity
        if (activity == null) {
            call.resolve(buildPermissionResult(
                sdkStatus,
                reason = "Health Connect permissions require an active Android activity."
            ))
            return
        }

        val intent = permissionRequest.createIntent(context, requiredPermissions())
        startActivityForResult(call, intent, "handleHealthConnectPermissionResult")
    }

    @PluginMethod
    fun getSnapshot(call: PluginCall) {
        val device = buildSnapshot("snapshot")
        scope.launch {
            val health = buildHealthSnapshot("snapshot")
            call.resolve(JSObject().apply {
                put("supported", true)
                put("snapshot", device)
                put("healthSnapshot", health)
            })
        }
    }

    private fun stopInternal() {
        if (receiver != null) {
            try {
                context.unregisterReceiver(receiver)
            } catch (_: Throwable) {
                // best-effort cleanup
            }
        }
        receiver = null
        monitoring = false
    }

    private fun buildStartResult(): JSObject {
        val snapshot = buildSnapshot("start")
        return JSObject().apply {
            put("enabled", monitoring)
            put("supported", true)
            put("platform", "android")
            put("snapshot", snapshot)
            put("healthSnapshot", JSONObject.NULL)
        }
    }

    private fun requiredPermissions(): Set<String> {
        return setOf(
            HealthPermission.getReadPermission(SleepSessionRecord::class),
            HealthPermission.getReadPermission(HeartRateRecord::class),
            HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        )
    }

    private suspend fun resolvePermissionResult(
        reason: String? = null,
    ): JSObject {
        val sdkStatus = HealthConnectClient.getSdkStatus(context, HEALTH_CONNECT_PACKAGE)
        return if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
            buildPermissionResult(sdkStatus, reason = reason)
        } else {
            val client = HealthConnectClient.getOrCreate(context)
            val granted = client.permissionController.getGrantedPermissions()
            buildPermissionResult(sdkStatus, granted, reason)
        }
    }

    private fun buildPermissionResult(
        sdkStatus: Int,
        grantedPermissions: Set<String>? = null,
        reason: String? = null,
    ): JSObject {
        val requestedPermissions = requiredPermissions()
        val sleepPermission = HealthPermission.getReadPermission(SleepSessionRecord::class)
        val biometricPermissions = setOf(
            HealthPermission.getReadPermission(HeartRateRecord::class),
            HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        )
        val granted = grantedPermissions ?: emptySet()
        val sleepGranted = granted.contains(sleepPermission)
        val biometricsGranted = granted.intersect(biometricPermissions).isNotEmpty()
        val allGranted = requestedPermissions.all { granted.contains(it) }
        val (status, canRequest, statusReason) = when (sdkStatus) {
            HealthConnectClient.SDK_AVAILABLE -> {
                if (allGranted) {
                    Triple("granted", false, reason)
                } else {
                    Triple("not-determined", true, reason)
                }
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> Triple(
                "not-applicable",
                false,
                reason ?: "Health Connect is installed but needs an update before Eliza can read health data.",
            )
            else -> Triple(
                "not-applicable",
                false,
                reason ?: "Health Connect is not available on this device.",
            )
        }

        return JSObject().apply {
            put("status", status)
            put("canRequest", canRequest)
            if (statusReason != null) {
                put("reason", statusReason)
            }
            put("permissions", JSObject().apply {
                put("sleep", sleepGranted)
                put("biometrics", biometricsGranted)
            })
        }
    }

    private fun buildSnapshot(reason: String): JSObject {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val keyguardManager = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))

        val interactive = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
            powerManager.isInteractive
        } else {
            @Suppress("DEPRECATION")
            powerManager.isScreenOn
        }
        val locked = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            keyguardManager.isDeviceLocked
        } else {
            @Suppress("DEPRECATION")
            keyguardManager.isKeyguardLocked
        }
        val powerSaveMode = powerManager.isPowerSaveMode
        val deviceIdle = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            powerManager.isDeviceIdleMode
        } else {
            false
        }
        val state = when {
            locked -> "locked"
            !interactive -> "background"
            powerSaveMode || deviceIdle -> "idle"
            else -> "active"
        }
        val idleState = when {
            locked -> "locked"
            !interactive || powerSaveMode || deviceIdle -> "idle"
            else -> "active"
        }
        val batteryLevel = battery?.let {
            val level = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = it.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (level >= 0 && scale > 0) {
                level.toDouble() / scale.toDouble()
            } else {
                null
            }
        }
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val isCharging = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) in setOf(
            BatteryManager.BATTERY_STATUS_CHARGING,
            BatteryManager.BATTERY_STATUS_FULL,
        )

        return JSObject().apply {
            put("source", "mobile_device")
            put("platform", "android")
            put("state", state)
            put("observedAt", System.currentTimeMillis())
            put("idleState", idleState)
            put("idleTimeSeconds", null)
            put("onBattery", plugged == 0)
            put("metadata", JSObject().apply {
                put("reason", reason)
                put("isInteractive", interactive)
                put("isDeviceLocked", locked)
                put("isPowerSaveMode", powerSaveMode)
                put("isDeviceIdleMode", deviceIdle)
                put("isCharging", isCharging)
                put("batteryLevel", batteryLevel)
            })
        }
    }

    private fun emitSignal(reason: String) {
        if (!monitoring) return
        notifyListeners("signal", buildSnapshot(reason))
    }

    private fun emitHealthSignal(reason: String) {
        if (!monitoring) return
        scope.launch {
            val healthSnapshot = buildHealthSnapshot(reason)
            if (monitoring) {
                notifyListeners("signal", healthSnapshot)
            }
        }
    }

    private suspend fun buildHealthSnapshot(reason: String): JSObject {
        val now = Instant.now()
        val sdkStatus = HealthConnectClient.getSdkStatus(context, HEALTH_CONNECT_PACKAGE)
        if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
            return makeHealthSnapshot(
                reason = reason,
                source = "health_connect",
                permissions = permissions(false, false),
                sleep = sleepSnapshot(false, false, null, null, null, null),
                biometrics = biometricsSnapshot(null, null, null, null, null, null),
                warnings = listOf("Health Connect provider unavailable or requires update"),
            )
        }

        val client = HealthConnectClient.getOrCreate(context)
        val start = now.minus(Duration.ofDays(7))
        val range = TimeRangeFilter.between(start, now)
        val warnings = mutableListOf<String>()

        val sleepSessions = runCatching {
            client.readRecords(
                ReadRecordsRequest<SleepSessionRecord>(
                    timeRangeFilter = range,
                )
            ).records
        }.getOrElse {
            warnings.add("Sleep Connect query failed")
            emptyList()
        }

        val latestSleep = sleepSessions.maxByOrNull { it.startTime }
        val sleepIsAvailable = latestSleep != null
        val sleepIsSleeping = latestSleep?.endTime?.isAfter(now) == true || latestSleep?.endTime == null
        val sleepAsleepAt = latestSleep?.startTime?.toEpochMilli()
        val sleepAwakeAt = if (sleepIsSleeping) null else latestSleep?.endTime?.toEpochMilli()
        val sleepDurationMinutes = latestSleep?.let {
            val end = if (sleepIsSleeping) now else it.endTime
            Duration.between(it.startTime, end).toMinutes()
        }
        val sleepStage = if (sleepIsSleeping) "sleeping" else "awake"

        val heartRateSamples = runCatching {
            client.readRecords(
                ReadRecordsRequest(
                    recordType = HeartRateRecord::class,
                    timeRangeFilter = range,
                )
            ).records.flatMap { it.samples }
        }.getOrElse {
            warnings.add("Heart rate Connect query failed")
            emptyList()
        }

        val hrvRecords = runCatching {
            client.readRecords(
                ReadRecordsRequest<HeartRateVariabilityRmssdRecord>(
                    timeRangeFilter = range,
                )
            ).records
        }.getOrElse {
            warnings.add("HRV Connect query failed")
            emptyList()
        }

        val latestHeartRate = heartRateSamples.maxByOrNull { it.time }
        val latestHrv = hrvRecords.maxByOrNull { it.time }
        val sampleAt = listOfNotNull(
            latestHeartRate?.time,
            latestHrv?.time,
        ).maxOrNull()?.toEpochMilli()

        return makeHealthSnapshot(
            reason = reason,
            source = "health_connect",
            permissions = permissions(
                sleep = sleepIsAvailable,
                biometrics = latestHeartRate != null || latestHrv != null,
            ),
            sleep = sleepSnapshot(
                available = sleepIsAvailable,
                isSleeping = sleepIsSleeping,
                asleepAt = sleepAsleepAt,
                awakeAt = sleepAwakeAt,
                durationMinutes = sleepDurationMinutes,
                stage = sleepStage,
            ),
            biometrics = biometricsSnapshot(
                sampleAt = sampleAt,
                heartRateBpm = latestHeartRate?.beatsPerMinute?.toDouble(),
                restingHeartRateBpm = null,
                heartRateVariabilityMs = latestHrv?.heartRateVariabilityMillis,
                respiratoryRate = null,
                bloodOxygenPercent = null,
            ),
            warnings = warnings,
        )
    }

    private fun permissions(sleep: Boolean, biometrics: Boolean): JSObject {
        return JSObject().apply {
            put("sleep", sleep)
            put("biometrics", biometrics)
        }
    }

    private fun sleepSnapshot(
        available: Boolean,
        isSleeping: Boolean,
        asleepAt: Long?,
        awakeAt: Long?,
        durationMinutes: Long?,
        stage: String?,
    ): JSObject {
        return JSObject().apply {
            put("available", available)
            put("isSleeping", isSleeping)
            put("asleepAt", asleepAt)
            put("awakeAt", awakeAt)
            put("durationMinutes", durationMinutes)
            put("stage", stage)
        }
    }

    private fun biometricsSnapshot(
        sampleAt: Long?,
        heartRateBpm: Double?,
        restingHeartRateBpm: Double?,
        heartRateVariabilityMs: Double?,
        respiratoryRate: Double?,
        bloodOxygenPercent: Double?,
    ): JSObject {
        return JSObject().apply {
            put("sampleAt", sampleAt)
            put("heartRateBpm", heartRateBpm)
            put("restingHeartRateBpm", restingHeartRateBpm)
            put("heartRateVariabilityMs", heartRateVariabilityMs)
            put("respiratoryRate", respiratoryRate)
            put("bloodOxygenPercent", bloodOxygenPercent)
        }
    }

    private fun makeHealthSnapshot(
        reason: String,
        source: String,
        permissions: JSObject,
        sleep: JSObject,
        biometrics: JSObject,
        warnings: List<String>,
    ): JSObject {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        return JSObject().apply {
            put("source", "mobile_health")
            put("platform", "android")
            put("state", if (sleep.getBool("isSleeping") == true) "sleeping" else "idle")
            put("observedAt", System.currentTimeMillis())
            put("idleState", JSONObject.NULL)
            put("idleTimeSeconds", JSONObject.NULL)
            put("onBattery", plugged == 0)
            put("healthSource", source)
            put("permissions", permissions)
            put("sleep", sleep)
            put("biometrics", biometrics)
            put("warnings", warnings)
            put("metadata", JSObject().apply {
                put("reason", reason)
                put("healthSource", source)
            })
        }
    }

    private fun handleOnDestroyInternal() {
        stopInternal()
        super.handleOnDestroy()
    }

    @ActivityCallback
    private fun handleHealthConnectPermissionResult(call: PluginCall, result: ActivityResult) {
        scope.launch {
            val reason = if (result.resultCode != android.app.Activity.RESULT_OK) {
                "Health Connect permissions were not granted."
            } else {
                null
            }
            call.resolve(resolvePermissionResult(reason))
        }
    }

    override fun handleOnDestroy() {
        handleOnDestroyInternal()
    }
}
