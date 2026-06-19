package ai.eliza.plugins.appblocker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AppBlockerForegroundService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var polling = false
    private var ownPackageName = ""
    private var overlayView: View? = null
    private var windowManager: WindowManager? = null

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (!polling) {
                return
            }
            checkForegroundApp()
            if (polling) {
                handler.postDelayed(this, POLL_INTERVAL_MS)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ownPackageName = packageName
        windowManager = getSystemService(WINDOW_SERVICE) as? WindowManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopPolling()
                hideBlockingOverlay()
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> Unit
            else -> return START_NOT_STICKY
        }

        val saved = AppBlockerStateStore.load(this)
        if (saved == null || saved.packageNames.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification(saved))
        startPolling()

        val endsAtEpochMs = saved.endsAtEpochMs
        if (endsAtEpochMs != null) {
            val delayMs = endsAtEpochMs - System.currentTimeMillis()
            if (delayMs > 0) {
                handler.postDelayed({
                    AppBlockerStateStore.clear(this)
                    stopPolling()
                    hideBlockingOverlay()
                    stopForegroundCompat()
                    stopSelf()
                }, delayMs)
            } else {
                AppBlockerStateStore.clear(this)
                stopSelf()
                return START_NOT_STICKY
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        stopPolling()
        hideBlockingOverlay()
        super.onDestroy()
    }

    private fun startPolling() {
        if (polling) {
            return
        }
        polling = true
        handler.post(pollRunnable)
    }

    private fun stopPolling() {
        polling = false
        handler.removeCallbacks(pollRunnable)
    }

    private fun checkForegroundApp() {
        val saved = AppBlockerStateStore.load(this)
        if (saved == null || saved.packageNames.isEmpty()) {
            hideBlockingOverlay()
            stopPolling()
            stopForegroundCompat()
            stopSelf()
            return
        }

        if (!Settings.canDrawOverlays(this)) {
            hideBlockingOverlay()
            return
        }

        val foregroundPackage = getForegroundPackage() ?: return
        val shouldBlock = foregroundPackage != ownPackageName &&
            foregroundPackage != "com.android.launcher" &&
            !foregroundPackage.contains("launcher", ignoreCase = true) &&
            AppBlockerStateStore.isBlocked(this, foregroundPackage)

        if (shouldBlock) {
            showBlockingOverlay(saved)
        } else {
            hideBlockingOverlay()
        }
    }

    private fun getForegroundPackage(): String? {
        val usageStatsManager = getSystemService("usagestats") as? UsageStatsManager ?: return null
        val now = System.currentTimeMillis()
        val usageEvents = usageStatsManager.queryEvents(now - 2_000, now)
        val event = UsageEvents.Event()
        var packageName: String? = null
        while (usageEvents.hasNextEvent()) {
            usageEvents.getNextEvent(event)
            if (event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                packageName = event.packageName
            }
        }
        return packageName
    }

    private fun showBlockingOverlay(saved: SavedAppBlock) {
        if (overlayView != null) {
            updateOverlayMessage(saved)
            return
        }

        val overlayCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
            setBackgroundColor(Color.parseColor("#E8EFE2"))
        }

        val titleView = TextView(this).apply {
            id = View.generateViewId()
            text = "App Blocked"
            textSize = 28f
            setTextColor(Color.parseColor("#132011"))
            gravity = Gravity.CENTER
        }

        val messageView = TextView(this).apply {
            id = View.generateViewId()
            tag = "message"
            textSize = 16f
            setTextColor(Color.parseColor("#2D3C2B"))
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 32)
        }

        val homeButton = Button(this).apply {
            text = "Go Home"
            setOnClickListener { goHome() }
        }

        overlayCard.addView(
            titleView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        overlayCard.addView(
            messageView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        overlayCard.addView(
            homeButton,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        val overlayRoot = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#CC132011"))
            addView(
                overlayCard,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER,
                ).apply {
                    marginStart = 48
                    marginEnd = 48
                },
            )
        }

        val windowType = if (Build.VERSION.SDK_INT >= 26) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val layoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            windowType,
            768,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.CENTER
        }

        updateOverlayMessage(saved, messageView)

        try {
            windowManager?.addView(overlayRoot, layoutParams)
            overlayView = overlayRoot
        } catch (_: Exception) {
            overlayView = null
        }
    }

    private fun updateOverlayMessage(saved: SavedAppBlock, messageView: TextView? = findOverlayMessageView()) {
        val message = saved.endsAtEpochMs?.let { endsAtEpochMs ->
            val formatter = SimpleDateFormat("h:mm a", Locale.getDefault())
            "This app is blocked by Eliza until ${formatter.format(Date(endsAtEpochMs))}."
        } ?: "This app is blocked by Eliza until you unblock it."
        messageView?.text = message
    }

    private fun findOverlayMessageView(): TextView? {
        val root = overlayView as? FrameLayout ?: return null
        return root.findViewWithTag("message") as? TextView
    }

    private fun hideBlockingOverlay() {
        val currentOverlay = overlayView ?: return
        try {
            windowManager?.removeView(currentOverlay)
            overlayView = null
        } catch (_: Exception) {
            overlayView = null
        }
    }

    private fun goHome() {
        val intent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
        }
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "App Blocker",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Eliza is monitoring and blocking selected apps."
        }
        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager?.createNotificationChannel(channel)
    }

    private fun buildNotification(saved: SavedAppBlock): Notification {
        val count = saved.packageNames.size
        val countSuffix = if (count == 1) "" else "s"
        val contentText = if (saved.endsAtEpochMs != null) {
            val formatter = SimpleDateFormat("h:mm a", Locale.getDefault())
            val endsAt = formatter.format(Date(saved.endsAtEpochMs))
            "Blocking $count app$countSuffix until $endsAt."
        } else {
            val pronoun = if (count == 1) "it" else "them"
            "Blocking $count app$countSuffix until you unblock $pronoun."
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("App Blocker Active")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setOngoing(true)
            .build()
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    companion object {
        const val ACTION_START = "ai.eliza.plugins.appblocker.ACTION_START"
        const val ACTION_STOP = "ai.eliza.plugins.appblocker.ACTION_STOP"

        private const val CHANNEL_ID = "eliza_app_blocker"
        private const val NOTIFICATION_ID = 9201
        private const val POLL_INTERVAL_MS = 500L
    }
}
