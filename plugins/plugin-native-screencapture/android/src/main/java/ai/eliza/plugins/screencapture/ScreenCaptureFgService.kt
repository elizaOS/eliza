package ai.eliza.plugins.screencapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Foreground service of type `mediaProjection`. Android 14+ (API 34) throws
 *   SecurityException: Media projections require a foreground service of type
 *   ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
 * from `MediaProjectionManager.getMediaProjection()` unless such a service is
 * already running. The screencapture plugin starts this service immediately
 * after the user grants the projection consent and stops it when the projection
 * is released, so a single screenshot / continuous capture works on Android 14+.
 */
class ScreenCaptureFgService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channelId = "eliza_screen_capture"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm != null && nm.getNotificationChannel(channelId) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        channelId,
                        "Screen capture",
                        NotificationManager.IMPORTANCE_LOW
                    )
                )
            }
        }
        val notification: Notification = Notification.Builder(this, channelId)
            .setContentTitle("Screen sharing active")
            .setContentText("This app is reading the screen.")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIF_ID, notification)
        }
        return START_NOT_STICKY
    }

    companion object {
        const val NOTIF_ID = 8451
    }
}
