package ai.eliza.plugins.websiteblocker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import android.util.Log
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicBoolean

class WebsiteBlockerVpnService : VpnService() {
    companion object {
        const val ACTION_START = "ai.eliza.websiteblocker.START"
        const val ACTION_STOP = "ai.eliza.websiteblocker.STOP"
        const val EXTRA_WEBSITES = "websites"
        const val EXTRA_ENDS_AT = "ends_at"
        private const val NOTIFICATION_CHANNEL_ID = "website_blocker_vpn"
        private const val NOTIFICATION_ID = 9184
        private const val VPN_ADDRESS = "10.77.0.1"
        private const val DNS_ADDRESS = "10.77.0.2"

        @Volatile
        private var activeInstance: WebsiteBlockerVpnService? = null

        fun isRunning(): Boolean = activeInstance != null
    }

    @Volatile
    private var vpnInterface: ParcelFileDescriptor? = null
    private val tunnelWriteLock = Any()
    @Volatile
    private var dnsForwarder: DnsForwarder? = null
    private var tunnelThread: Thread? = null
    private val tunnelRunning = AtomicBoolean(false)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var scheduledStop: Runnable? = null
    private var shouldClearStateOnStop = false
    @Volatile
    private var blockedWebsites: Set<String> = emptySet()
    @Volatile
    private var allowedWebsites: Set<String> = emptySet()
    @Volatile
    private var matchMode: String = "exact"
    @Volatile
    private var activePolicy: SavedWebsiteBlock? = null

    override fun onCreate() {
        super.onCreate()
        activeInstance = this
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        if (action == ACTION_STOP) {
            stopBlocking()
            return START_NOT_STICKY
        }

        val persisted = WebsiteBlockerStateStore.load(this)
        val websites = intent?.getStringArrayListExtra(EXTRA_WEBSITES)
            ?.mapNotNull(WebsiteBlockerStateStore::normalizeHostname)
            ?.distinct()
            ?: persisted?.requestedWebsites
            ?: emptyList()
        if (websites.isEmpty()) {
            stopBlocking()
            return START_NOT_STICKY
        }

        val endsAt = when {
            intent?.hasExtra(EXTRA_ENDS_AT) == true -> {
                val value = intent.getLongExtra(EXTRA_ENDS_AT, -1L)
                if (value > 0L) value else null
            }
            else -> persisted?.endsAtEpochMs
        }

        val savedBlock = WebsiteBlockerStateStore.save(this, websites, endsAt)
            ?: run {
                stopBlocking()
                return START_NOT_STICKY
            }
        activePolicy = savedBlock
        blockedWebsites = savedBlock.blockedWebsites.toSet()
        allowedWebsites = savedBlock.allowedWebsites.toSet()
        matchMode = savedBlock.matchMode
        shouldClearStateOnStop = false
        startForegroundNotification()
        establishVpn()
        startTunnelLoop()
        scheduleStop(endsAt)
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        cancelScheduledStop()
        stopTunnelLoop()
        if (shouldClearStateOnStop) {
            WebsiteBlockerStateStore.clear(this)
        }
        activeInstance = null
    }

    override fun onRevoke() {
        stopBlocking()
        super.onRevoke()
    }

    private fun establishVpn() {
        if (vpnInterface != null) {
            return
        }

        val builder = Builder()
            .setSession("Eliza Website Blocker")
            .setBlocking(false)
            .setMtu(1500)
            .addAddress(VPN_ADDRESS, 32)
            .addRoute(DNS_ADDRESS, 32)
            .addDnsServer(DNS_ADDRESS)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setMetered(false)
        }

        vpnInterface = builder.establish()
    }

    private fun startTunnelLoop() {
        if (tunnelRunning.get()) {
            return
        }

        val descriptor = vpnInterface ?: return
        val forwarder = DnsForwarder(::resolveUpstreamDnsServers) { protect(it) }
        dnsForwarder = forwarder
        tunnelRunning.set(true)
        tunnelThread = Thread {
            val dnsAddress = InetAddress.getByName(DNS_ADDRESS) as Inet4Address
            val packetBuffer = ByteArray(32_767)
            val poll = StructPollfd().apply {
                fd = descriptor.fileDescriptor
                events = OsConstants.POLLIN.toShort()
            }
            while (tunnelRunning.get() && !Thread.currentThread().isInterrupted) {
                try {
                    // Closing a descriptor does not cancel a blocking TUN read.
                    // Bounded polling lets stop release the interface even when idle.
                    if (Os.poll(arrayOf(poll), 250) == 0) continue
                    if (!tunnelRunning.get() || Thread.currentThread().isInterrupted) break
                    val length = Os.read(descriptor.fileDescriptor, packetBuffer, 0, packetBuffer.size)
                    if (length <= 0) continue
                    val query = DnsPacketCodec.parseUdpDnsQuery(packetBuffer, length, dnsAddress)
                        ?: continue
                    // The service can receive another START while the tunnel stays up.
                    // Take one coherent policy snapshot for each incoming query.
                    val policy = activePolicy ?: continue
                    if (WebsiteBlockerStateStore.isBlockedHostname(policy, query.queryName)) {
                        sendDnsResponse(descriptor, forwarder, query,
                            DnsPacketCodec.buildBlockedDnsResponse(query.dnsPayload))
                    } else {
                        forwarder.submit(query.dnsPayload) { response ->
                            try {
                                sendDnsResponse(descriptor, forwarder, query,
                                    response ?: DnsPacketCodec.buildServerFailureDnsResponse(query.dnsPayload))
                            } catch (error: Exception) {
                                failTunnel(descriptor, error)
                            }
                        }
                    }
                } catch (error: Exception) {
                    // error-policy:J1 Shutdown closes the descriptor; other I/O failures stop enforcement.
                    if (tunnelRunning.get() && !Thread.currentThread().isInterrupted) {
                        failTunnel(descriptor, error)
                    }
                    break
                }
            }
        }.apply {
            name = "ElizaWebsiteBlockerVpn"
            isDaemon = true
            start()
        }
    }

    private fun sendDnsResponse(descriptor: ParcelFileDescriptor, forwarder: DnsForwarder,
        query: DnsQueryPacket, payload: ByteArray) {
        val response = DnsPacketCodec.buildUdpDnsResponse(query, payload)
        synchronized(tunnelWriteLock) {
            // Responses from an expired/stopped tunnel cannot write into its replacement.
            if (dnsForwarder !== forwarder || vpnInterface !== descriptor || !tunnelRunning.get()) return
            check(Os.write(descriptor.fileDescriptor, response, 0, response.size) == response.size) {
                "Incomplete DNS tunnel response"
            }
        }
    }

    private fun failTunnel(descriptor: ParcelFileDescriptor, error: Exception) {
        if (vpnInterface !== descriptor) return
        Log.e("WebsiteBlockerVpn", "DNS tunnel failed", error)
        mainHandler.post {
            if (vpnInterface === descriptor) {
                stopTunnelLoop()
                stopSelf()
            }
        }
    }

    private fun stopTunnelLoop() {
        val stopped = synchronized(tunnelWriteLock) {
            tunnelRunning.set(false)
            val previous = dnsForwarder
            dnsForwarder = null
            tunnelThread?.interrupt()
            tunnelThread = null
            try {
                vpnInterface?.close()
            } catch (error: Exception) {
                Log.w("WebsiteBlockerVpn", "Failed to close DNS tunnel", error)
            }
            vpnInterface = null
            previous
        }
        // Close owned sockets and cancel queued work; reads use bounded waits.
        stopped?.close()
    }

    private fun resolveUpstreamDnsServers(): List<InetAddress> {
        val connectivityManager =
            applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val network = connectivityManager?.activeNetwork
        val linkProperties = connectivityManager?.getLinkProperties(network)
        val dnsServers = linkProperties?.dnsServers
            ?.filterIsInstance<Inet4Address>()
            ?.filter { it.hostAddress != DNS_ADDRESS }
            .orEmpty()
        if (dnsServers.isNotEmpty()) {
            return dnsServers
        }
        return listOf(
            InetAddress.getByName("1.1.1.1"),
            InetAddress.getByName("8.8.8.8"),
        )
    }

    private fun stopBlocking() {
        shouldClearStateOnStop = true
        cancelScheduledStop()
        stopTunnelLoop()
        WebsiteBlockerStateStore.clear(this)
        stopSelf()
    }

    private fun scheduleStop(endsAtEpochMs: Long?) {
        cancelScheduledStop()
        if (endsAtEpochMs == null) {
            return
        }

        val delayMs = endsAtEpochMs - System.currentTimeMillis()
        if (delayMs <= 0) {
            stopBlocking()
            return
        }

        val stopRunnable = Runnable {
            stopBlocking()
        }
        scheduledStop = stopRunnable
        mainHandler.postDelayed(stopRunnable, delayMs)
    }

    private fun cancelScheduledStop() {
        scheduledStop?.let { mainHandler.removeCallbacks(it) }
        scheduledStop = null
    }

    private fun startForegroundNotification() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) == null
        ) {
            createNotificationChannel()
        }

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
                .setContentTitle("Eliza Website Blocker")
                .setContentText("Blocking ${blockedWebsites.joinToString(", ")}")
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle("Eliza Website Blocker")
                .setContentText("Blocking ${blockedWebsites.joinToString(", ")}")
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setOngoing(true)
                .build()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) != null) {
            return
        }
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Eliza Website Blocker",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Foreground notification while website blocking is active"
            },
        )
    }
}
