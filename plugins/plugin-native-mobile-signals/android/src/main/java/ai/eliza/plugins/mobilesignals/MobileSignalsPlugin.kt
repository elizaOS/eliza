package ai.eliza.plugins.mobilesignals

import android.Manifest
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
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
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import org.json.JSONObject

private const val HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata"
private const val NOTIFICATION_PERMISSION_ALIAS = "notifications"

@CapacitorPlugin(
    name = "MobileSignals",
    permissions = [
        Permission(
            alias = NOTIFICATION_PERMISSION_ALIAS,
            strings = [Manifest.permission.POST_NOTIFICATIONS],
        ),
    ],
)
class MobileSignalsPlugin : Plugin() {
    private val tag = "MobileSignalsPlugin"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val permissionRequest = PermissionController.createRequestPermissionResultContract()
    private val deviceReader by lazy { MobileSignalsDeviceReader(context.applicationContext) }
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
        val target = call.getString("target") ?: "all"
        if (target == "notifications") {
            requestNotificationPermission(call)
            return
        }
        if (target == "screenTime") {
            val (_, intent) = settingsIntentFor("usageAccess")
            try {
                val starter = activity
                if (starter != null) {
                    starter.startActivity(intent)
                } else {
                    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                scope.launch {
                    call.resolve(resolvePermissionResult("Opened Android Usage Access settings."))
                }
            } catch (error: Throwable) {
                scope.launch {
                    call.resolve(resolvePermissionResult("Failed to open Android Usage Access settings: ${error.message}"))
                }
            }
            return
        }

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

    private fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            openNotificationSettingsOrResolve(call)
            return
        }
        val current = notificationPermissionStatus()
        if (current.status == "granted") {
            scope.launch {
                call.resolve(resolvePermissionResult())
            }
            return
        }
        if (!current.canRequest) {
            openNotificationSettingsOrResolve(call)
            return
        }
        requestPermissionForAlias(
            NOTIFICATION_PERMISSION_ALIAS,
            call,
            "handleNotificationsPermissionResult",
        )
    }

    private fun openNotificationSettingsOrResolve(call: PluginCall) {
        val (_, intent) = settingsIntentFor("notification")
        try {
            val starter = activity
            if (starter != null) {
                starter.startActivity(intent)
            } else {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            scope.launch {
                call.resolve(resolvePermissionResult("Opened Android notification settings."))
            }
        } catch (error: Throwable) {
            scope.launch {
                call.resolve(resolvePermissionResult("Failed to open Android notification settings: ${error.message}"))
            }
        }
    }

    @PermissionCallback
    private fun handleNotificationsPermissionResult(call: PluginCall) {
        scope.launch {
            call.resolve(resolvePermissionResult())
        }
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val requestedTarget = call.getString("target") ?: "app"
        val (actualTarget, intent) = settingsIntentFor(requestedTarget)
        try {
            val starter = activity
            if (starter != null) {
                starter.startActivity(intent)
            } else {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            call.resolve(JSObject().apply {
                put("opened", true)
                put("target", requestedTarget)
                put("actualTarget", actualTarget)
                put("reason", JSONObject.NULL)
            })
        } catch (error: Throwable) {
            Log.e(tag, "Failed to open settings", error)
            call.resolve(JSObject().apply {
                put("opened", false)
                put("target", requestedTarget)
                put("actualTarget", actualTarget)
                put("reason", "Failed to open Android settings: ${error.message}")
            })
        }
    }

    @PluginMethod
    fun getSnapshot(call: PluginCall) {
        val device = deviceReader.buildSnapshot("snapshot")
        scope.launch {
            val health = buildHealthSnapshot("snapshot")
            call.resolve(JSObject().apply {
                put("supported", true)
                put("snapshot", device)
                put("healthSnapshot", health)
            })
        }
    }

    @PluginMethod
    fun scheduleBackgroundRefresh(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("scheduled", false)
            put("reason", "Android mobile signals use foreground monitoring and system broadcasts instead of BGTaskScheduler.")
        })
    }

    @PluginMethod
    fun cancelBackgroundRefresh(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("cancelled", false)
            put("reason", "Android mobile signals do not register a BGTaskScheduler background refresh task.")
        })
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
        val snapshot = deviceReader.buildSnapshot("start")
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
            put("canOpenSettings", true)
            put("settingsTarget", if (status == "granted") JSONObject.NULL else "healthConnect")
            put("engine", "health-connect-usage-stats")
            put("capabilities", mobileSignalsCapabilities(sdkStatus))
            if (statusReason != null) {
                put("reason", statusReason)
            }
            put("screenTime", deviceReader.buildScreenTimeStatus())
            put("setupActions", buildSetupActions(status, canRequest, sdkStatus))
            put("permissions", JSObject().apply {
                put("sleep", sleepGranted)
                put("biometrics", biometricsGranted)
            })
        }
    }

    private fun mobileSignalsCapabilities(sdkStatus: Int): JSObject {
        return JSObject().apply {
            put("health", sdkStatus == HealthConnectClient.SDK_AVAILABLE)
            put("screenTime", true)
            put("notifications", true)
            put("settings", true)
        }
    }

    private fun emitSignal(reason: String) {
        if (!monitoring) return
        notifyListeners("signal", deviceReader.buildSnapshot(reason))
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
        // Treat a sleep session as still in progress only when it ends in the
        // future or very recently. Older sessions describe a completed sleep
        // that has already been woken up from, and must not be reported as
        // "sleeping now". Matches the iOS freshness window.
        val sleepFreshnessWindow = Duration.ofMinutes(15)
        val sleepIsSleeping = latestSleep != null &&
            latestSleep.endTime.isAfter(now.minus(sleepFreshnessWindow))
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
            put("screenTime", deviceReader.buildScreenTimeStatus())
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

    private data class NotificationPermissionStatus(
        val status: String,
        val canRequest: Boolean,
        val reason: String?,
    )

    private fun notificationPermissionStatus(): NotificationPermissionStatus {
        val appNotificationsEnabled = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.areNotificationsEnabled()
        } else {
            true
        }

        val runtimeState = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getPermissionState(NOTIFICATION_PERMISSION_ALIAS)
        } else {
            PermissionState.GRANTED
        }

        if (runtimeState == PermissionState.GRANTED && appNotificationsEnabled) {
            return NotificationPermissionStatus("granted", false, null)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && runtimeState != PermissionState.GRANTED) {
            val canRequest = runtimeState != PermissionState.DENIED
            return NotificationPermissionStatus(
                if (runtimeState == PermissionState.DENIED) "denied" else "not-determined",
                canRequest,
                if (canRequest) {
                    "Allow notifications when LifeOps needs to remind or prompt you."
                } else {
                    "Notifications are denied for Eliza. Open Android settings to enable reminders and prompts."
                },
            )
        }

        return NotificationPermissionStatus(
            "denied",
            false,
            "Notifications are disabled for Eliza. Open Android settings to enable reminders and prompts.",
        )
    }

    private fun buildSetupActions(
        healthStatus: String,
        healthCanRequest: Boolean,
        sdkStatus: Int,
    ): JSArray {
        val actions = mutableListOf<JSObject>()
        actions.add(JSObject().apply {
            put("id", "health_permissions")
            put("label", "Health Connect")
            put(
                "status",
                when {
                    sdkStatus != HealthConnectClient.SDK_AVAILABLE -> "unavailable"
                    healthStatus == "granted" -> "ready"
                    else -> "needs-action"
                },
            )
            put("canRequest", healthCanRequest)
            put("canOpenSettings", true)
            put(
                "settingsTarget",
                if (sdkStatus == HealthConnectClient.SDK_AVAILABLE) "healthConnect" else "deviceSettings",
            )
            put(
                "reason",
                when {
                    sdkStatus != HealthConnectClient.SDK_AVAILABLE -> "Install or update Health Connect to sync sleep and biometric signals."
                    healthStatus == "granted" -> JSONObject.NULL
                    else -> "Grant Health Connect read access for sleep, heart rate, and HRV."
                },
            )
        })
        val usageGranted = deviceReader.hasUsageStatsAccess()
        actions.add(JSObject().apply {
            put("id", "android_usage_access")
            put("label", "Usage Access")
            put("status", if (usageGranted) "ready" else "needs-action")
            put("canRequest", false)
            put("canOpenSettings", true)
            put("settingsTarget", "usageAccess")
            put(
                "reason",
                if (usageGranted) {
                    JSONObject.NULL
                } else {
                    "Enable Usage Access so LifeOps can summarize foreground app usage for wake and bed inference."
                },
            )
        })
        val notifications = notificationPermissionStatus()
        actions.add(JSObject().apply {
            put("id", "notification_settings")
            put("label", "Notifications")
            put("status", if (notifications.status == "granted") "ready" else "needs-action")
            put("canRequest", notifications.canRequest)
            put("canOpenSettings", true)
            put("settingsTarget", "notification")
            put("reason", notifications.reason ?: JSONObject.NULL)
        })
        actions.add(JSObject().apply {
            put("id", "battery_optimization")
            put("label", "Battery optimization")
            put("status", "needs-action")
            put("canRequest", false)
            put("canOpenSettings", true)
            put("settingsTarget", "batteryOptimization")
            put("reason", "Disable aggressive battery optimization if background sync stops.")
        })
        return JSArray(actions)
    }

    private fun settingsIntentFor(target: String): Pair<String, Intent> {
        val appDetailsIntent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${context.packageName}"),
        )
        val intent = when (target) {
            "usageAccess", "screenTime" -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            "health", "healthConnect" -> Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$HEALTH_CONNECT_PACKAGE"),
            )
            "notification" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(
                    Settings.EXTRA_APP_PACKAGE,
                    context.packageName,
                )
            } else {
                appDetailsIntent
            }
            "batteryOptimization" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "deviceSettings" -> Intent(Settings.ACTION_SETTINGS)
            else -> appDetailsIntent
        }
        val actualTarget = when (target) {
            "usageAccess", "screenTime" -> "usageAccess"
            "health", "healthConnect" -> "healthConnect"
            "notification" -> "notification"
            "batteryOptimization" -> "batteryOptimization"
            "deviceSettings" -> "deviceSettings"
            else -> "app"
        }
        return Pair(actualTarget, intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
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
