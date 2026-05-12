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
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
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

    private var vpnInterface: ParcelFileDescriptor? = null
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
            shouldClearStateOnStop = true
            stopSelf()
            return START_NOT_STICKY
        }

        val persisted = WebsiteBlockerStateStore.load(this)
        val websites = intent?.getStringArrayListExtra(EXTRA_WEBSITES)
            ?.mapNotNull(WebsiteBlockerStateStore::normalizeHostname)
            ?.distinct()
            ?: persisted?.requestedWebsites
            ?: emptyList()
        if (websites.isEmpty()) {
            shouldClearStateOnStop = true
            stopSelf()
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
                shouldClearStateOnStop = true
                stopSelf()
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
        shouldClearStateOnStop = true
        super.onRevoke()
        stopSelf()
    }

    private fun establishVpn() {
        if (vpnInterface != null) {
            return
        }

        val builder = Builder()
            .setSession("Eliza Website Blocker")
            .setBlocking(true)
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
        val policy = activePolicy ?: WebsiteBlockerStateStore.load(this) ?: return
        tunnelRunning.set(true)
        tunnelThread = Thread {
            val dnsAddress = InetAddress.getByName(DNS_ADDRESS) as Inet4Address
            FileInputStream(descriptor.fileDescriptor).use { input ->
                FileOutputStream(descriptor.fileDescriptor).use { output ->
                    val packetBuffer = ByteArray(32_767)
                    while (tunnelRunning.get()) {
                        val length = try {
                            input.read(packetBuffer)
                        } catch (_: Exception) {
                            break
                        }
                        if (length <= 0) {
                            continue
                        }

                        val query = DnsPacketCodec.parseUdpDnsQuery(packetBuffer, length, dnsAddress)
                            ?: continue
                        val responsePayload = if (
                            WebsiteBlockerStateStore.isBlockedHostname(policy, query.queryName)
                        ) {
                            DnsPacketCodec.buildBlockedDnsResponse(query.dnsPayload)
                        } else {
                            forwardDnsQuery(query.dnsPayload)
                                ?: DnsPacketCodec.buildServerFailureDnsResponse(query.dnsPayload)
                        }

                        val responsePacket = DnsPacketCodec.buildUdpDnsResponse(query, responsePayload)
                        try {
                            output.write(responsePacket)
                        } catch (_: Exception) {
                            break
                        }
                    }
                }
            }
        }.apply {
            name = "ElizaWebsiteBlockerVpn"
            isDaemon = true
            start()
        }
    }

    private fun stopTunnelLoop() {
        tunnelRunning.set(false)
        tunnelThread?.interrupt()
        tunnelThread = null
        try {
            vpnInterface?.close()
        } catch (_: Exception) {
        }
        vpnInterface = null
    }

    private fun forwardDnsQuery(queryPayload: ByteArray): ByteArray? {
        val upstreamServers = resolveUpstreamDnsServers()
        for (server in upstreamServers) {
            try {
                DatagramSocket().use { socket ->
                    protect(socket)
                    socket.soTimeout = 3_000
                    socket.connect(InetSocketAddress(server, 53))
                    socket.send(DatagramPacket(queryPayload, queryPayload.size))
                    val responseBuffer = ByteArray(4_096)
                    val responsePacket = DatagramPacket(responseBuffer, responseBuffer.size)
                    socket.receive(responsePacket)
                    return responseBuffer.copyOf(responsePacket.length)
                }
            } catch (_: Exception) {
            }
        }
        return null
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

    private fun scheduleStop(endsAtEpochMs: Long?) {
        cancelScheduledStop()
        if (endsAtEpochMs == null) {
            return
        }

        val delayMs = endsAtEpochMs - System.currentTimeMillis()
        if (delayMs <= 0) {
            shouldClearStateOnStop = true
            stopSelf()
            return
        }

        val stopRunnable = Runnable {
            shouldClearStateOnStop = true
            stopSelf()
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
