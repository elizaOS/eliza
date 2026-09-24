package ai.eliza.testing

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import java.io.Closeable

/** Explicitly opted-in stock emulator only; restores every setting it changes. */
class NetworkTransitionFixture(context: Context) : Closeable {
    private val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private fun shell(command: String): String =
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use {
            ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() }
        }
    private val wifiEnabled = shell("settings get global wifi_on")
    private val dataEnabled = shell("settings get global mobile_data")
    private val originalMetered = metered()
    private val network: String
    private val override: String

    init {
        check(android.os.Build.HARDWARE in setOf("ranchu", "goldfish"))
        check(wifiEnabled == "1" && dataEnabled in setOf("0", "1")) { "Expected enabled Wi-Fi and known mobile-data state" }
        check(connectivity.getNetworkCapabilities(connectivity.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) {
            "Transitions require an active Wi-Fi network"
        }
        val configurations = shell("cmd netpolicy list wifi-networks").lines().filter { it.isNotBlank() }.distinct()
        check(configurations.size == 1) { "Use an isolated emulator with one Wi-Fi policy: $configurations" }
        val entry = configurations.single().split(';')
        check(entry.size == 2 && entry[0].matches(Regex("[A-Za-z0-9_.-]+"))) { "Unsupported emulator Wi-Fi identifier" }
        network = entry[0]
        override = when (entry[1]) {
            "none" -> "undefined"
            "true", "false" -> entry[1]
            else -> error("Unknown metering override: ${entry[1]}")
        }
    }

    private fun metered(): Boolean? {
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return null
        return !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    private fun awaitMetered(expected: Boolean?) {
        val deadline = System.nanoTime() + 30_000_000_000L
        while (metered() != expected) {
            check(System.nanoTime() < deadline) { "Network transition timed out: wanted $expected, got ${metered()}" }
            Thread.sleep(100)
        }
    }

    fun run(checkBridge: (String, Any) -> Unit) {
        shell("svc data disable")
        for (expected in listOf(false, true, false)) {
            shell("cmd netpolicy set metered-network $network $expected")
            awaitMetered(expected)
            checkBridge(if (expected) "metered" else "unmetered", expected)
        }
        shell("svc wifi disable")
        awaitMetered(null)
        checkBridge("offline", JSONObject.NULL)
        close()
        checkBridge("restored", originalMetered ?: JSONObject.NULL)
    }

    override fun close() {
        shell("cmd netpolicy set metered-network $network $override")
        shell("svc wifi enable")
        shell("svc data ${if (dataEnabled == "1") "enable" else "disable"}")
        awaitMetered(originalMetered)
        check(shell("settings get global wifi_on") == wifiEnabled) { "Wi-Fi setting was not restored" }
        check(shell("settings get global mobile_data") == dataEnabled) { "Mobile-data setting was not restored" }
        val expectedPolicy = "$network;${if (override == "undefined") "none" else override}"
        check(shell("cmd netpolicy list wifi-networks").lines().filter { it.isNotBlank() }.distinct() == listOf(expectedPolicy)) {
            "Original Wi-Fi metering override was not restored"
        }
    }
}
