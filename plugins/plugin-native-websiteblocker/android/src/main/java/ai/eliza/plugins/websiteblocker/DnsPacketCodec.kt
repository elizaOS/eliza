package ai.eliza.plugins.websiteblocker

import java.net.Inet4Address

data class DnsQueryPacket(
    val sourceAddress: ByteArray,
    val destinationAddress: ByteArray,
    val sourcePort: Int,
    val destinationPort: Int,
    val dnsPayload: ByteArray,
    val queryName: String,
)

object DnsPacketCodec {
    private const val IPV4_HEADER_SIZE = 20
    private const val UDP_HEADER_SIZE = 8

    fun parseUdpDnsQuery(
        packet: ByteArray,
        length: Int,
        expectedDnsAddress: Inet4Address,
    ): DnsQueryPacket? {
        if (length < IPV4_HEADER_SIZE + UDP_HEADER_SIZE + 12) {
            return null
        }

        val version = (packet[0].toInt() ushr 4) and 0x0F
        val headerLength = (packet[0].toInt() and 0x0F) * 4
        if (version != 4 || headerLength < IPV4_HEADER_SIZE || length < headerLength + UDP_HEADER_SIZE) {
            return null
        }

        val protocol = packet[9].toInt() and 0xFF
        if (protocol != 17) {
            return null
        }

        val destinationAddress = packet.copyOfRange(16, 20)
        if (!destinationAddress.contentEquals(expectedDnsAddress.address)) {
            return null
        }

        val udpOffset = headerLength
        val sourcePort = readUInt16(packet, udpOffset)
        val destinationPort = readUInt16(packet, udpOffset + 2)
        if (destinationPort != 53) {
            return null
        }

        val udpLength = readUInt16(packet, udpOffset + 4)
        if (udpLength < UDP_HEADER_SIZE || udpOffset + udpLength > length) {
            return null
        }

        val dnsOffset = udpOffset + UDP_HEADER_SIZE
        val dnsPayload = packet.copyOfRange(dnsOffset, dnsOffset + udpLength - UDP_HEADER_SIZE)
        val queryName = parseQueryName(dnsPayload) ?: return null

        return DnsQueryPacket(
            sourceAddress = packet.copyOfRange(12, 16),
            destinationAddress = destinationAddress,
            sourcePort = sourcePort,
            destinationPort = destinationPort,
            dnsPayload = dnsPayload,
            queryName = queryName,
        )
    }

    fun buildBlockedDnsResponse(queryPayload: ByteArray): ByteArray {
        val response = queryPayload.copyOf()
        response[2] = (response[2].toInt() or 0x80).toByte()
        response[3] = ((response[3].toInt() and 0xF0) or 0x03).toByte()
        response[6] = 0
        response[7] = 0
        response[8] = 0
        response[9] = 0
        response[10] = 0
        response[11] = 0
        return response
    }

    fun buildServerFailureDnsResponse(queryPayload: ByteArray): ByteArray {
        val response = queryPayload.copyOf()
        response[2] = (response[2].toInt() or 0x80).toByte()
        response[3] = ((response[3].toInt() and 0xF0) or 0x02).toByte()
        response[6] = 0
        response[7] = 0
        response[8] = 0
        response[9] = 0
        response[10] = 0
        response[11] = 0
        return response
    }

    fun buildUdpDnsResponse(query: DnsQueryPacket, dnsPayload: ByteArray): ByteArray {
        val udpLength = UDP_HEADER_SIZE + dnsPayload.size
        val totalLength = IPV4_HEADER_SIZE + udpLength
        val response = ByteArray(totalLength)

        response[0] = 0x45
        response[1] = 0
        writeUInt16(response, 2, totalLength)
        writeUInt16(response, 4, 0)
        writeUInt16(response, 6, 0)
        response[8] = 64
        response[9] = 17
        writeUInt16(response, 10, 0)

        System.arraycopy(query.destinationAddress, 0, response, 12, 4)
        System.arraycopy(query.sourceAddress, 0, response, 16, 4)
        writeUInt16(response, IPV4_HEADER_SIZE, query.destinationPort)
        writeUInt16(response, IPV4_HEADER_SIZE + 2, query.sourcePort)
        writeUInt16(response, IPV4_HEADER_SIZE + 4, udpLength)
        writeUInt16(response, IPV4_HEADER_SIZE + 6, 0)
        System.arraycopy(dnsPayload, 0, response, IPV4_HEADER_SIZE + UDP_HEADER_SIZE, dnsPayload.size)

        val checksum = computeIpv4HeaderChecksum(response, IPV4_HEADER_SIZE)
        writeUInt16(response, 10, checksum)
        return response
    }

    private fun parseQueryName(payload: ByteArray): String? {
        if (payload.size < 12) {
            return null
        }
        var offset = 12
        val labels = mutableListOf<String>()
        while (offset < payload.size) {
            val length = payload[offset].toInt() and 0xFF
            if (length == 0) {
                return labels.joinToString(".")
            }
            if (length and 0xC0 != 0 || offset + 1 + length > payload.size) {
                return null
            }
            val label = payload.copyOfRange(offset + 1, offset + 1 + length)
                .toString(Charsets.UTF_8)
            labels += label
            offset += length + 1
        }
        return null
    }

    private fun readUInt16(buffer: ByteArray, offset: Int): Int {
        return ((buffer[offset].toInt() and 0xFF) shl 8) or
            (buffer[offset + 1].toInt() and 0xFF)
    }

    private fun writeUInt16(buffer: ByteArray, offset: Int, value: Int) {
        buffer[offset] = ((value ushr 8) and 0xFF).toByte()
        buffer[offset + 1] = (value and 0xFF).toByte()
    }

    private fun computeIpv4HeaderChecksum(packet: ByteArray, headerLength: Int): Int {
        var sum = 0
        var offset = 0
        while (offset < headerLength) {
            if (offset == 10) {
                offset += 2
                continue
            }
            sum += readUInt16(packet, offset)
            while (sum > 0xFFFF) {
                sum = (sum and 0xFFFF) + (sum ushr 16)
            }
            offset += 2
        }
        return sum.inv() and 0xFFFF
    }
}
