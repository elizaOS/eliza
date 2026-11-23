package ai.eliza.plugins.websiteblocker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class WebsiteBlockerBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (
            action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }

        val savedBlock = WebsiteBlockerStateStore.load(context) ?: return
        if (android.net.VpnService.prepare(context) != null) {
            return
        }

        ContextCompat.startForegroundService(
            context,
            Intent(context, WebsiteBlockerVpnService::class.java).apply {
                this.action = WebsiteBlockerVpnService.ACTION_START
                putStringArrayListExtra(
                    WebsiteBlockerVpnService.EXTRA_WEBSITES,
                    ArrayList(savedBlock.requestedWebsites),
                )
                putExtra(
                    WebsiteBlockerVpnService.EXTRA_ENDS_AT,
                    savedBlock.endsAtEpochMs ?: -1L,
                )
            },
        )
    }
}
