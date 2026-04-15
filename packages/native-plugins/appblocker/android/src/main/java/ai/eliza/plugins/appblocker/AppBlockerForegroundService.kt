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

    companion object {
        const val ACTION_START = "ai.eliza.plugins.appblocker.ACTION_START"
        const val ACTION_STOP = "ai.eliza.plugins.appblocker.ACTION_STOP"
        private const val CHANNEL_ID = "eliza_app_blocker"
        private const val NOTIFICATION_ID = 9201
        private const val POLL_INTERVAL_MS = 750L
    }

    private val handler = Handler(Looper.getMainLooper())
    private var polling = false
    private var ownPackageName: String = ""
    private var overlayView: View? = null
    private var windowManager: WindowManager? = null

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (!polling) return
            checkForegroundApp()
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ownPackageName = packageName
        windowManager = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopPolling()
                hideBlockingOverlay()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                val block = AppBlockerStateStore.load(this)
                if (block == null || block.packageNames.isEmpty()) {
                    stopSelf()
                    return START_NOT_STICKY
                }

                startForeground(NOTIFICATION_ID, buildNotification(block))
                startPolling()

                // Schedule auto-stop if there's an expiry
                if (block.endsAtEpochMs != null) {
                    val delay = block.endsAtEpochMs - System.currentTimeMillis()
                    if (delay > 0) {
                        handler.postDelayed({
                            AppBlockerStateStore.clear(this)
                            stopPolling()
                            hideBlockingOverlay()
                            stopForeground(STOP_FOREGROUND_REMOVE)
                            stopSelf()
                        }, delay)
                    } else {
                        AppBlockerStateStore.clear(this)
                        stopSelf()
                        return START_NOT_STICKY
                    }
                }

                return START_STICKY
            }
            else -> return START_NOT_STICKY
        }
    }

    override fun onDestroy() {
        stopPolling()
        hideBlockingOverlay()
        super.onDestroy()
    }

    private fun startPolling() {
        if (polling) return
        polling = true
        handler.post(pollRunnable)
    }

    private fun stopPolling() {
        polling = false
        handler.removeCallbacks(pollRunnable)
    }

    private fun checkForegroundApp() {
        val savedBlock = AppBlockerStateStore.load(this)
        if (savedBlock == null || savedBlock.packageNames.isEmpty()) {
            hideBlockingOverlay()
            stopPolling()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }

        if (!Settings.canDrawOverlays(this)) {
            hideBlockingOverlay()
            return
        }

        val foreground = getForegroundPackage() ?: return
        val shouldBlock = foreground != ownPackageName &&
            foreground != "com.android.launcher" &&
            !foreground.contains("launcher", ignoreCase = true) &&
            AppBlockerStateStore.isBlocked(this, foreground)

        if (shouldBlock) {
            showBlockingOverlay(savedBlock)
            return
        }

        hideBlockingOverlay()
    }

    private fun getForegroundPackage(): String? {
        val usm = getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return null
        val now = System.currentTimeMillis()
        val events = usm.queryEvents(now - 2000, now)
        val event = UsageEvents.Event()
        var lastResumed: String? = null

        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == UsageEvents.Event.ACTIVITY_RESUMED) {
                lastResumed = event.packageName
            }
        }
        return lastResumed
    }

    private fun showBlockingOverlay(block: SavedAppBlock) {
        if (overlayView != null) {
            updateOverlayMessage(block)
            return
        }

        val contentContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
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

        contentContainer.addView(
            titleView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        contentContainer.addView(
            messageView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        contentContainer.addView(
            homeButton,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        val overlayRoot = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#CC132011"))
            addView(
                contentContainer,
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

        val layoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            },
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.CENTER
        }

        updateOverlayMessage(block, messageView)
        try {
            windowManager?.addView(overlayRoot, layoutParams)
            overlayView = overlayRoot
        } catch (_: Exception) {
            overlayView = null
        }
    }

    private fun updateOverlayMessage(block: SavedAppBlock, messageView: TextView? = findOverlayMessageView()) {
        val text = if (block.endsAtEpochMs != null) {
            val formatter = SimpleDateFormat("h:mm a", Locale.getDefault())
            "This app is blocked by Eliza until ${formatter.format(Date(block.endsAtEpochMs))}."
        } else {
            "This app is blocked by Eliza until you unblock it."
        }
        messageView?.text = text
    }

    private fun findOverlayMessageView(): TextView? {
        val root = overlayView as? FrameLayout ?: return null
        return root.findViewWithTag<View>("message") as? TextView
    }

    private fun hideBlockingOverlay() {
        val root = overlayView ?: return
        try {
            windowManager?.removeView(root)
        } catch (_: Exception) {
            // Ignore stale overlay cleanup failures.
        } finally {
            overlayView = null
        }
    }

    private fun goHome() {
        val homeIntent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(homeIntent)
        } catch (_: ActivityNotFoundException) {
            // Nothing to do if Android can't resolve a launcher.
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
        val nm = getSystemService(NotificationManager::class.java)
        nm?.createNotificationChannel(channel)
    }

    private fun buildNotification(block: SavedAppBlock): Notification {
        val count = block.packageNames.size
        val text = if (block.endsAtEpochMs != null) {
            "Blocking $count app${if (count != 1) "s" else ""} until block expires."
        } else {
            "Blocking $count app${if (count != 1) "s" else ""} until you unblock."
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("App Blocker Active")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setOngoing(true)
            .build()
    }
}
