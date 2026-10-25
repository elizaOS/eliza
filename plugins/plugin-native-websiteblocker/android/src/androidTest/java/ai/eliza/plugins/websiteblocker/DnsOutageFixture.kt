package ai.eliza.plugins.websiteblocker

import android.os.Build
import java.io.File
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice

/** Drops upstream DNS replies on an isolated emulator, preserving local TUN replies. */
internal class DnsOutageFixture : AutoCloseable {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val chain = requireNotNull(InstrumentationRegistry.getArguments().getString("dnsOutageChain"))
        .also { check(it.matches(Regex("ELIZA_DNS_[a-f0-9]{12}"))) }
    private val rule = "-p udp --sport 53 ! -s 10.77.0.2 -j $chain"
    private var created = false
    private var linked = false

    init {
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "DNS outage requires an isolated stock emulator" }
        check(device.executeShellCommand("pm list packages ai.elizaos.app").isBlank()) { "Do not disrupt a user app's network" }
        try {
            command("-N $chain")
            created = true
            command("-A $chain -j DROP")
            command("-I INPUT 1 $rule")
            linked = true
        } catch (error: Throwable) {
            try { close() } catch (cleanup: Throwable) { error.addSuppressed(cleanup) }
            throw error
        }
    }

    private fun command(arguments: String): String {
        // UiAutomation tokenizes commands without shell quote handling.
        val script = File.createTempFile("dns-outage-", ".sh", instrumentation.targetContext.cacheDir)
        val output = try {
            script.writeText("iptables -w $arguments\necho ELIZA_EXIT=\$?\n")
            device.executeShellCommand("su 0 sh ${script.absolutePath}")
        } finally {
            check(script.delete()) { "Failed to remove owned DNS fixture script" }
        }
        check(output.trimEnd().endsWith("ELIZA_EXIT=0")) { "DNS outage rule failed: $arguments: $output" }
        return output
    }

    fun droppedPackets(): Long {
        val output = command("-nvx -L $chain")
        return Regex("(?m)^\\s*(\\d+)\\s+\\d+\\s+DROP\\b").find(output)?.groupValues?.get(1)?.toLong()
            ?: error("Missing owned DNS drop counter: $output")
    }

    override fun close() {
        if (linked) { command("-D INPUT $rule"); linked = false }
        if (created) { command("-F $chain"); command("-X $chain"); created = false }
    }
}
