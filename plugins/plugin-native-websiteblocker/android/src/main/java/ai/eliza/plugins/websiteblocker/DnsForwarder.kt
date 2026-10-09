package ai.eliza.plugins.websiteblocker

import android.util.Log
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Owns bounded upstream work; DNS timeouts must never stall local block responses. */
internal class DnsForwarder(
    private val servers: () -> List<InetAddress>,
    private val protect: (DatagramSocket) -> Boolean,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val sockets = ConcurrentHashMap.newKeySet<DatagramSocket>()
    private val executor = ThreadPoolExecutor(4, 4, 0, TimeUnit.MILLISECONDS,
        ArrayBlockingQueue<Runnable>(64), { task ->
            Thread(task, "ElizaWebsiteDns").apply { isDaemon = true }
        })

    fun submit(payload: ByteArray, reply: (ByteArray?) -> Unit) {
        if (closed.get()) return
        try {
            executor.execute {
                val response = try { forward(payload) } catch (error: RuntimeException) {
                    // error-policy:J1 Unexpected platform failures become explicit DNS SERVFAIL.
                    Log.e("WebsiteBlockerVpn", "Upstream DNS failed", error)
                    null
                }
                if (!closed.get()) reply(response)
            }
        } catch (_: RejectedExecutionException) {
            // Saturation returns SERVFAIL without blocking the packet reader.
            if (!closed.get()) reply(null)
        }
    }

    private fun forward(payload: ByteArray): ByteArray? {
        for (server in servers()) {
            if (closed.get()) return null
            try {
                DatagramSocket().use { socket ->
                    sockets.add(socket)
                    try {
                        // close() may race socket creation; never leave a late socket alive.
                        if (closed.get()) return null
                        if (!protect(socket)) throw IOException("Cannot protect upstream DNS socket")
                        // Android can remain in native poll after close; bound each wait
                        // while retaining the full upstream timeout budget.
                        socket.soTimeout = 200
                        socket.connect(InetSocketAddress(server, 53))
                        socket.send(DatagramPacket(payload, payload.size))
                        val packet = DatagramPacket(ByteArray(4_096), 4_096)
                        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
                        while (!closed.get()) {
                            try {
                                socket.receive(packet)
                                return packet.data.copyOf(packet.length)
                            } catch (error: SocketTimeoutException) {
                                if (System.nanoTime() >= deadline) throw error
                            }
                        }
                        return null
                    } finally {
                        sockets.remove(socket)
                    }
                }
            } catch (_: IOException) {
                // An unavailable upstream tries the next server, then returns SERVFAIL.
            }
        }
        return null
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        executor.shutdownNow()
        sockets.forEach { it.close() }
    }
}
