package ai.eliza.plugins.websiteblocker

import android.content.Context
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.Inet4Address
import java.net.InetAddress
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WebsiteBlockerStateStoreInstrumentedTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @After
    fun clearState() {
        WebsiteBlockerStateStore.clear(context)
    }

    @Test
    fun saveLoadAndBlockDecisionUseDeviceSharedPreferences() {
        WebsiteBlockerStateStore.clear(context)

        val saved = WebsiteBlockerStateStore.save(
            context,
            listOf("  X.COM. ", "news.google.com", "localhost"),
            System.currentTimeMillis() + 60_000L,
        )
        assertNotNull(saved)

        val loaded = WebsiteBlockerStateStore.load(context)
        assertNotNull(loaded)
        requireNotNull(loaded)
        assertEquals(listOf("news.google.com", "x.com"), loaded.requestedWebsites)
        assertTrue(loaded.blockedWebsites.contains("t.co"))
        assertTrue(loaded.blockedWebsites.contains("twitter.com"))
        assertTrue(loaded.blockedWebsites.contains("news.google.com"))
        assertTrue(loaded.allowedWebsites.contains("api.x.com"))
        assertTrue(loaded.allowedWebsites.contains("accounts.google.com"))
        assertEquals("exact", loaded.matchMode)

        assertTrue(WebsiteBlockerStateStore.isBlockedHostname(loaded, "x.com"))
        assertTrue(WebsiteBlockerStateStore.isBlockedHostname(loaded, "t.co"))
        assertTrue(WebsiteBlockerStateStore.isBlockedHostname(loaded, "news.google.com"))
        assertFalse(WebsiteBlockerStateStore.isBlockedHostname(loaded, "api.x.com"))
        assertFalse(WebsiteBlockerStateStore.isBlockedHostname(loaded, "accounts.google.com"))
    }

    @Test
    fun elapsedBlockExpiresAndClearsDeviceState() {
        WebsiteBlockerStateStore.clear(context)
        WebsiteBlockerStateStore.save(
            context,
            listOf("example.com"),
            System.currentTimeMillis() - 1_000L,
        )

        assertNull(WebsiteBlockerStateStore.load(context))
        assertNull(WebsiteBlockerStateStore.load(context))
    }

    @Test
    fun dnsCodecParsesQueryAndBuildsBlockedUdpResponseOnDevice() {
        val dnsAddress = InetAddress.getByName("10.77.0.2") as Inet4Address
        val packet = buildUdpDnsQuery(
            sourceAddress = byteArrayOf(10, 0, 0, 2),
            destinationAddress = dnsAddress.address,
            sourcePort = 45_321,
            queryName = "x.com",
        )

        val parsed = DnsPacketCodec.parseUdpDnsQuery(packet, packet.size, dnsAddress)
        assertNotNull(parsed)
        requireNotNull(parsed)
        assertEquals("x.com", parsed.queryName)
        assertEquals(45_321, parsed.sourcePort)
        assertEquals(53, parsed.destinationPort)
        assertArrayEquals(byteArrayOf(10, 0, 0, 2), parsed.sourceAddress)
        assertArrayEquals(dnsAddress.address, parsed.destinationAddress)

        val blockedPayload = DnsPacketCodec.buildBlockedDnsResponse(parsed.dnsPayload)
        assertEquals(0x80, blockedPayload[2].toInt() and 0x80)
        assertEquals(3, blockedPayload[3].toInt() and 0x0F)

        val response = DnsPacketCodec.buildUdpDnsResponse(parsed, blockedPayload)
        assertArrayEquals(dnsAddress.address, response.copyOfRange(12, 16))
        assertArrayEquals(byteArrayOf(10, 0, 0, 2), response.copyOfRange(16, 20))
        assertEquals(53, readUInt16(response, 20))
        assertEquals(45_321, readUInt16(response, 22))
    }

    @Test
    fun showcaseActivityRendersPersistedPolicy() {
        ActivityScenario.launch(WebsiteBlockerShowcaseActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val text = activity.snapshotText()
                assertTrue(text.contains("Website Blocker State"))
                assertTrue(text.contains("Active: true"))
                assertTrue(text.contains("Blocked x.com: true"))
                assertTrue(text.contains("Allowed api.x.com: false"))
            }
        }
    }

    private fun buildUdpDnsQuery(
        sourceAddress: ByteArray,
        destinationAddress: ByteArray,
        sourcePort: Int,
        queryName: String,
    ): ByteArray {
        val dnsPayload = buildDnsQueryPayload(queryName)
        val udpLength = 8 + dnsPayload.size
        val totalLength = 20 + udpLength
        val packet = ByteArray(totalLength)
        packet[0] = 0x45
        packet[8] = 64
        packet[9] = 17
        writeUInt16(packet, 2, totalLength)
        System.arraycopy(sourceAddress, 0, packet, 12, 4)
        System.arraycopy(destinationAddress, 0, packet, 16, 4)
        writeUInt16(packet, 20, sourcePort)
        writeUInt16(packet, 22, 53)
        writeUInt16(packet, 24, udpLength)
        System.arraycopy(dnsPayload, 0, packet, 28, dnsPayload.size)
        return packet
    }

    private fun buildDnsQueryPayload(queryName: String): ByteArray {
        val labels = queryName.split(".")
        val nameBytes = labels.flatMap { label ->
            listOf(label.length.toByte()) + label.toByteArray(Charsets.UTF_8).toList()
        } + listOf(0.toByte())
        val payload = ByteArray(12 + nameBytes.size + 4)
        writeUInt16(payload, 0, 0x4D53)
        writeUInt16(payload, 2, 0x0100)
        writeUInt16(payload, 4, 1)
        nameBytes.forEachIndexed { index, value -> payload[12 + index] = value }
        val questionOffset = 12 + nameBytes.size
        writeUInt16(payload, questionOffset, 1)
        writeUInt16(payload, questionOffset + 2, 1)
        return payload
    }

    private fun readUInt16(buffer: ByteArray, offset: Int): Int {
        return ((buffer[offset].toInt() and 0xFF) shl 8) or
            (buffer[offset + 1].toInt() and 0xFF)
    }

    private fun writeUInt16(buffer: ByteArray, offset: Int, value: Int) {
        buffer[offset] = ((value ushr 8) and 0xFF).toByte()
        buffer[offset + 1] = (value and 0xFF).toByte()
    }
}
