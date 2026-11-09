package ai.eliza.plugins.mobilesignals

import android.Manifest
import android.app.NotificationManager
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.health.connect.HealthConnectManager
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import org.json.JSONObject

private const val HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata"
private const val FAMILY_CONTROLS_ENTITLEMENT = "com.apple.developer.family-controls"
private const val PACKAGE_USAGE_STATS_PERMISSION = "android.permission.PACKAGE_USAGE_STATS"
private const val NOTIFICATION_PERMISSION_ALIAS = "notifications"
private const val USAGE_SUMMARY_TTL_MS = 60_000L
private val SCREEN_ACTIONS = setOf(
    Intent.ACTION_SCREEN_ON,
    Intent.ACTION_SCREEN_OFF,
    Intent.ACTION_USER_PRESENT,
)

/**
 * Lets an ACTION_BATTERY_CHANGED broadcast through only when the level or the
 * plug state moved. Android repeats the broadcast for voltage and temperature
 * changes, which nothing here reports.
 */
internal class BatteryChangeFilter {
    private var level: Int? = null
    private var plugged: Int? = null

    @Synchronized
    fun changed(level: Int, plugged: Int): Boolean {
        if (level == this.level && plugged == this.plugged) return false
        this.level = level
        this.plugged = plugged
        return true
    }

    @Synchronized
    fun reset() {
        level = null
        plugged = null
    }
}

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
    // A failure that escapes a launch is logged here instead of reaching the
    // thread's uncaught handler, which would kill the host process.
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, error ->
            Log.e("MobileSignalsPlugin", "Mobile signals task failed", error)
        },
    )
    // Broadcasts are handled off the main thread, one at a time and in order.
    private val signalDispatcher = Dispatchers.IO.limitedParallelism(1)
    private val permissionRequest = PermissionController.createRequestPermissionResultContract()
    // Read from the broadcast coroutines as well as the plugin thread.
    @Volatile
    private var monitoring = false
    private var receiver: BroadcastReceiver? = null
    private val batteryFilter = BatteryChangeFilter()
    @Volatile
    private var usageCache: Pair<Long, UsageStatsReader.UsageSummary>? = null

    // Reads the granted Health Connect permissions. A field so the instrumented
    // test can make the binder call fail.
    internal var readGrantedPermissions: suspend (HealthConnectClient) -> Set<String> = {
        it.permissionController.getGrantedPermissions()
    }

    // The PACKAGE_USAGE_STATS reads (AppOps access check + UsageStatsManager query)
    // live in UsageStatsReader so they are exercisable by an instrumented
    // androidTest without a Capacitor Bridge (issue #9967).
    private val usageReader by lazy { UsageStatsReader(context) }

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
                if (action == Intent.ACTION_BATTERY_CHANGED && !batteryFilter.changed(
                        intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
                        intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0),
                    )
                ) {
                    return
                }
                val screenEvent = action in SCREEN_ACTIONS
                scope.launch(signalDispatcher) {
                    if (screenEvent) usageCache = null
                    emitSignal("broadcast:$action")
                    if (screenEvent) emitHealthSignal(action)
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
            // The sticky battery intent comes back here and is also delivered to
            // the receiver; seeding the filter keeps it from emitting twice.
            context.registerReceiver(receiver, filter)?.let { battery ->
                batteryFilter.changed(
                    battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
                    battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0),
                )
            }
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

    // Settles the call when the work throws, so a Health Connect binder failure
    // rejects the promise instead of leaving it pending.
    private fun launchSettling(call: PluginCall, block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                Log.e(tag, "Mobile signals call failed", error)
                call.reject("Mobile signals call failed: ${error.message}")
            }
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
        launchSettling(call) {
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
            if (!isUsageStatsPermissionDeclared()) {
                launchSettling(call) {
                    call.resolve(resolvePermissionResult("PACKAGE_USAGE_STATS is missing from the Android manifest."))
                }
                return
            }
            val (_, intent) = settingsIntentFor("usageAccess")
            try {
                val starter = activity
                if (starter != null) {
                    starter.startActivity(intent)
                } else {
                    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                launchSettling(call) {
                    call.resolve(resolvePermissionResult("Opened Android Usage Access settings."))
                }
            } catch (error: Throwable) {
                launchSettling(call) {
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
            launchSettling(call) {
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
            launchSettling(call) {
                call.resolve(resolvePermissionResult("Opened Android notification settings."))
            }
        } catch (error: Throwable) {
            launchSettling(call) {
                call.resolve(resolvePermissionResult("Failed to open Android notification settings: ${error.message}"))
            }
        }
    }

    @PermissionCallback
    private fun handleNotificationsPermissionResult(call: PluginCall) {
        launchSettling(call) {
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
    fun presentScreenTimeReport(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("presented", false)
            put("reason", "Android usage summaries are host-readable and do not use DeviceActivity reports.")
        })
    }

    @PluginMethod
    fun getSnapshot(call: PluginCall) {
        launchSettling(call) {
            usageCache = null
            val device = buildSnapshot("snapshot")
            // An explicit read returns the snapshot even when a Health Connect
            // read failed; its warnings say which part is missing.
            val (health, _) = buildHealthSnapshot("snapshot")
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
        batteryFilter.reset()
        usageCache = null
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
            val granted = readGrantedPermissions(client)
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
            put("screenTime", buildScreenTimeStatus())
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
            put("screenTime", isUsageStatsPermissionDeclared())
            put("notifications", true)
            put("settings", true)
        }
    }

    // Idle time = seconds since the last foreground app interaction (the best
    // available proxy for input idle from UsageStats). The earlier locked/
    // interactive branch was dead — both arms returned the same value.
    private fun computeIdleTimeSeconds(): Long? {
        if (!hasUsageStatsAccess()) return null
        return cachedUsageSummary().idleSeconds(System.currentTimeMillis())
    }

    // Battery and power broadcasts can arrive in bursts; one usage query serves
    // them for a minute. Screen events and explicit snapshots clear the cache.
    // Callers check hasUsageStatsAccess first, so only granted reads are kept.
    private fun cachedUsageSummary(): UsageStatsReader.UsageSummary {
        val now = System.currentTimeMillis()
        usageCache?.let { (at, summary) ->
            if (now - at in 0 until USAGE_SUMMARY_TTL_MS) return summary
        }
        return usageReader.collectLastDay(now).also { usageCache = now to it }
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
        val idleTimeSeconds = computeIdleTimeSeconds()

        return JSObject().apply {
            put("source", "mobile_device")
            put("platform", "android")
            put("state", state)
            put("observedAt", System.currentTimeMillis())
            put("idleState", idleState)
            if (idleTimeSeconds != null) {
                put("idleTimeSeconds", idleTimeSeconds)
            } else {
                put("idleTimeSeconds", JSONObject.NULL)
            }
            put("onBattery", plugged == 0)
            put("metadata", JSObject().apply {
                put("reason", reason)
                put("isInteractive", interactive)
                put("isDeviceLocked", locked)
                put("isPowerSaveMode", powerSaveMode)
                put("isDeviceIdleMode", deviceIdle)
                put("isCharging", isCharging)
                put("batteryLevel", batteryLevel ?: JSONObject.NULL)
                put("screenTime", buildUsageStatsSummary())
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
            val (healthSnapshot, readFailed) = buildHealthSnapshot(reason)
            // Health Connect refuses reads while the host is in the background,
            // and screen events often arrive then. A failed read must not replace
            // a good earlier snapshot with one that looks like an empty week.
            if (readFailed) {
                Log.w(tag, "Skipped health signal after a failed Health Connect read ($reason)")
                return@launch
            }
            if (monitoring) {
                notifyListeners("signal", healthSnapshot)
            }
        }
    }

    /** Returns the snapshot and whether any Health Connect read failed. */
    private suspend fun buildHealthSnapshot(reason: String): Pair<JSObject, Boolean> {
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
            ) to false
        }

        val client = HealthConnectClient.getOrCreate(context)
        val start = now.minus(Duration.ofDays(7))
        val range = TimeRangeFilter.between(start, now)
        val warnings = mutableListOf<String>()

        val granted = runCatching { readGrantedPermissions(client) }.getOrElse {
            warnings.add("Health Connect permission check failed")
            emptySet()
        }
        val sleepGranted = granted.contains(HealthPermission.getReadPermission(SleepSessionRecord::class))
        val heartRateGranted = granted.contains(HealthPermission.getReadPermission(HeartRateRecord::class))
        val hrvGranted = granted.contains(HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class))

        // Only granted record types are read, so a missing grant reads as no
        // data rather than as a failed read. Each read asks for the newest
        // records first; the default ascending page of 1000 would hold the
        // oldest records of the week.
        val latestSleep = if (!sleepGranted) null else runCatching {
            client.readRecords(
                ReadRecordsRequest(
                    recordType = SleepSessionRecord::class,
                    timeRangeFilter = range,
                    ascendingOrder = false,
                    pageSize = 1,
                )
            ).records.maxByOrNull { it.startTime }
        }.getOrElse {
            warnings.add("Sleep Connect query failed")
            null
        }

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

        // A heart rate record holds a series of samples; several sources can
        // write overlapping records, so take the newest few and the newest sample.
        val latestHeartRate = if (!heartRateGranted) null else runCatching {
            client.readRecords(
                ReadRecordsRequest(
                    recordType = HeartRateRecord::class,
                    timeRangeFilter = range,
                    ascendingOrder = false,
                    pageSize = 10,
                )
            ).records.flatMap { it.samples }.maxByOrNull { it.time }
        }.getOrElse {
            warnings.add("Heart rate Connect query failed")
            null
        }

        val latestHrv = if (!hrvGranted) null else runCatching {
            client.readRecords(
                ReadRecordsRequest(
                    recordType = HeartRateVariabilityRmssdRecord::class,
                    timeRangeFilter = range,
                    ascendingOrder = false,
                    pageSize = 1,
                )
            ).records.maxByOrNull { it.time }
        }.getOrElse {
            warnings.add("HRV Connect query failed")
            null
        }

        val sampleAt = listOfNotNull(
            latestHeartRate?.time,
            latestHrv?.time,
        ).maxOrNull()?.toEpochMilli()

        return makeHealthSnapshot(
            reason = reason,
            source = "health_connect",
            permissions = permissions(
                sleep = sleepGranted,
                biometrics = heartRateGranted || hrvGranted,
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
        ) to warnings.isNotEmpty()
    }

    private fun permissions(sleep: Boolean, biometrics: Boolean): JSObject {
        return JSObject().apply {
            put("sleep", sleep)
            put("biometrics", biometrics)
        }
    }

    // Nullable fields are written as JSONObject.NULL: JSObject.put drops a key
    // for a Kotlin null, and the TypeScript contract is number | null.
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
            put("asleepAt", asleepAt ?: JSONObject.NULL)
            put("awakeAt", awakeAt ?: JSONObject.NULL)
            put("durationMinutes", durationMinutes ?: JSONObject.NULL)
            put("stage", stage ?: JSONObject.NULL)
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
            put("sampleAt", sampleAt ?: JSONObject.NULL)
            put("heartRateBpm", heartRateBpm ?: JSONObject.NULL)
            put("restingHeartRateBpm", restingHeartRateBpm ?: JSONObject.NULL)
            put("heartRateVariabilityMs", heartRateVariabilityMs ?: JSONObject.NULL)
            put("respiratoryRate", respiratoryRate ?: JSONObject.NULL)
            put("bloodOxygenPercent", bloodOxygenPercent ?: JSONObject.NULL)
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
            put("screenTime", buildScreenTimeStatus())
            put("permissions", permissions)
            put("sleep", sleep)
            put("biometrics", biometrics)
            put("warnings", JSArray(warnings))
            put("metadata", JSObject().apply {
                put("reason", reason)
                put("healthSource", source)
            })
        }
    }

    private fun buildScreenTimeStatus(
        reason: String = "Android Usage Access is required for app foreground-time summaries.",
    ): JSObject {
        val usageGranted = hasUsageStatsAccess()
        val usagePermissionDeclared = isUsageStatsPermissionDeclared()
        val totalTimeForegroundMs = if (usageGranted) {
            collectUsageStatsSummary().totalTimeForegroundMs
        } else {
            null
        }
        val status = when {
            !usagePermissionDeclared -> "unavailable"
            usageGranted -> "approved"
            else -> "not-determined"
        }
        val resolvedReason = when {
            !usagePermissionDeclared -> "PACKAGE_USAGE_STATS is missing from the Android manifest."
            usageGranted -> null
            else -> reason
        }
        return JSObject().apply {
            put("supported", usagePermissionDeclared)
            put("hostEnvironment", "android")
            put(
                "availability",
                when {
                    !usagePermissionDeclared -> "provisioning-missing"
                    usageGranted -> "host-summary-available"
                    else -> "usage-access-required"
                },
            )
            put("requirements", JSObject().apply {
                put("entitlements", JSObject().apply {
                    put("familyControls", FAMILY_CONTROLS_ENTITLEMENT)
                })
                put("frameworks", JSArray(listOf("FamilyControls", "DeviceActivity")))
                put("deviceActivityReportExtension", false)
                put("deviceActivityMonitorExtension", false)
                put("android", JSObject().apply {
                    put("usageStatsPermission", PACKAGE_USAGE_STATS_PERMISSION)
                    put("usageAccessSettingsAction", Settings.ACTION_USAGE_ACCESS_SETTINGS)
                })
            })
            put("entitlements", JSObject().apply {
                put("familyControls", false)
            })
            put("provisioning", JSObject().apply {
                put("satisfied", usagePermissionDeclared)
                put("status", if (usagePermissionDeclared) "verified" else "missing")
                put("inspected", "not-inspectable")
                put("reason", if (usagePermissionDeclared) JSONObject.NULL else resolvedReason)
            })
            put("authorization", JSObject().apply {
                put("status", status)
                put("canRequest", false)
            })
            put("reportAvailable", false)
            put("coarseSummaryAvailable", usageGranted)
            put("thresholdEventsAvailable", false)
            put("rawUsageExportAvailable", false)
            put("android", JSObject().apply {
                put("usageAccessGranted", usageGranted)
                put("packageUsageStatsPermissionDeclared", usagePermissionDeclared)
                put("canOpenUsageAccessSettings", usagePermissionDeclared)
                put("foregroundEventsAvailable", usageGranted)
                put("totalTimeForegroundMs", totalTimeForegroundMs ?: JSONObject.NULL)
            })
            put("reason", resolvedReason ?: JSONObject.NULL)
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
        val usageGranted = hasUsageStatsAccess()
        val usagePermissionDeclared = isUsageStatsPermissionDeclared()
        actions.add(JSObject().apply {
            put("id", "android_usage_access")
            put("label", "Usage Access")
            put(
                "status",
                when {
                    !usagePermissionDeclared -> "unavailable"
                    usageGranted -> "ready"
                    else -> "needs-action"
                },
            )
            put("canRequest", false)
            put("canOpenSettings", usagePermissionDeclared)
            put("settingsTarget", if (usagePermissionDeclared) "usageAccess" else JSONObject.NULL)
            put(
                "reason",
                when {
                    !usagePermissionDeclared -> "PACKAGE_USAGE_STATS is missing from the Android manifest."
                    usageGranted -> JSONObject.NULL
                    else -> "Enable Usage Access so LifeOps can summarize foreground app usage for wake and bed inference."
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
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val batteryExempt = powerManager.isIgnoringBatteryOptimizations(context.packageName)
        actions.add(JSObject().apply {
            put("id", "battery_optimization")
            put("label", "Battery optimization")
            put("status", if (batteryExempt) "ready" else "needs-action")
            put("canRequest", false)
            put("canOpenSettings", true)
            put("settingsTarget", "batteryOptimization")
            put(
                "reason",
                if (batteryExempt) {
                    JSONObject.NULL
                } else {
                    "Disable aggressive battery optimization if background sync stops."
                },
            )
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
            "health", "healthConnect" -> healthConnectSettingsIntent() ?: appDetailsIntent
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
            "health", "healthConnect" -> if (intent === appDetailsIntent) "app" else "healthConnect"
            "notification" -> "notification"
            "batteryOptimization" -> "batteryOptimization"
            "deviceSettings" -> "deviceSettings"
            else -> "app"
        }
        return Pair(actualTarget, intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // Health Connect is a platform module from Android 14, where the old
    // com.google.android.apps.healthdata app page no longer exists. Returns
    // null when no activity on this device handles either screen.
    private fun healthConnectSettingsIntent(): Intent? {
        val candidates = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                add(
                    Intent(HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS)
                        .putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName),
                )
            }
            add(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
        }
        return candidates.firstOrNull { it.resolveActivity(context.packageManager) != null }
    }

    private fun hasUsageStatsAccess(): Boolean = usageReader.hasUsageStatsAccess()

    private fun isUsageStatsPermissionDeclared(): Boolean = usageStatsPermissionDeclared

    // The manifest cannot change while the app runs.
    private val usageStatsPermissionDeclared: Boolean by lazy {
        try {
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()),
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.GET_PERMISSIONS,
                )
            }
            packageInfo.requestedPermissions?.contains(PACKAGE_USAGE_STATS_PERMISSION) == true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    private data class UsageStatsSummary(
        val totalTimeForegroundMs: Long,
        val topApps: List<JSObject>,
    )

    private fun collectUsageStatsSummary(): UsageStatsSummary {
        val summary = cachedUsageSummary()
        val topApps = summary.topApps.map { usage ->
            JSObject().apply {
                put("packageName", usage.packageName)
                put("totalTimeForegroundMs", usage.totalTimeForegroundMs)
                put("lastTimeUsed", usage.lastTimeUsed)
            }
        }
        return UsageStatsSummary(summary.totalTimeForegroundMs, topApps)
    }

    private fun buildUsageStatsSummary(): JSObject {
        val granted = hasUsageStatsAccess()
        val summary = if (granted) {
            collectUsageStatsSummary()
        } else {
            UsageStatsSummary(0, emptyList())
        }
        return JSObject().apply {
            put("granted", granted)
            put("permissionDeclared", isUsageStatsPermissionDeclared())
            put("windowHours", 24)
            put("totalTimeForegroundMs", if (granted) summary.totalTimeForegroundMs else JSONObject.NULL)
            put("topApps", JSArray(summary.topApps))
        }
    }

    private fun handleOnDestroyInternal() {
        stopInternal()
        scope.cancel()
        super.handleOnDestroy()
    }

    @ActivityCallback
    private fun handleHealthConnectPermissionResult(call: PluginCall, result: ActivityResult) {
        launchSettling(call) {
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
