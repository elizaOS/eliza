package com.elizaos.facewear.evenrealities

import android.annotation.SuppressLint
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.ParcelUuid
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

enum class GlassSide { LEFT, RIGHT }

/**
 * BLE GATT service for Even Realities G1 whole-headset pairing.
 *
 * G1 exposes each lens as a separate Nordic UART Service peripheral:
 *   Service UUID: 6e400001-b5a3-f393-e0a9-e50e24dcca9e
 *   TX write:     6e400002-b5a3-f393-e0a9-e50e24dcca9e
 *   RX notify:    6e400003-b5a3-f393-e0a9-e50e24dcca9e
 *
 * This native bridge intentionally mirrors the TypeScript protocol in
 * plugin-facewear: display text uses 0x4E framed packets, mic control writes
 * 0x0E to the right lens, brightness writes 0x01 to both lenses, and pairing is
 * not considered ready until both left and right lenses are connected.
 */
class G1BleService : Service() {

    private val tag = "G1BleService"

    private val nusServiceUuid = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
    private val nusTxCharUuid = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
    private val nusRxCharUuid = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
    private val cccdUuid = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private val cmdSendResult = 0x4E.toByte()
    private val cmdStartAi = 0xF5.toByte()
    private val cmdOpenMic = 0x0E.toByte()
    private val cmdHeartbeat = 0x25.toByte()
    private val cmdBattery = 0x2C.toByte()
    private val cmdBrightness = 0x01.toByte()
    private val cmdInit = 0x4D.toByte()
    private val cmdRightInit = 0xF4.toByte()

    private val binder = LocalBinder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var leScanner: BluetoothLeScanner? = null
    private val gatts = mutableMapOf<GlassSide, BluetoothGatt>()
    private val txCharacteristics = mutableMapOf<GlassSide, BluetoothGattCharacteristic>()
    private val discoveredAddresses = mutableSetOf<String>()
    private var displaySeq = 0
    private var heartbeatSeq = 0

    var onStatusChange: ((String) -> Unit)? = null
    var onDataReceived: ((GlassSide, ByteArray) -> Unit)? = null

    inner class LocalBinder : Binder() {
        val service: G1BleService get() = this@G1BleService
    }

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        bluetoothAdapter = manager.adapter
        leScanner = bluetoothAdapter?.bluetoothLeScanner
    }

    override fun onBind(intent: Intent): IBinder = binder

    @SuppressLint("MissingPermission")
    fun startScan() {
        val scanner = leScanner ?: run {
            onStatusChange?.invoke("Bluetooth LE scanner not available")
            return
        }

        disconnect()
        discoveredAddresses.clear()
        onStatusChange?.invoke("Scanning for G1 left and right lenses...")

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        scanner.startScan(emptyList(), settings, scanCallback)

        scope.launch {
            delay(15_000)
            scanner.stopScan(scanCallback)
            val connected = connectedSides()
            onStatusChange?.invoke(
                if (connected.size == 2) {
                    "Whole G1 headset connected"
                } else {
                    "Scan complete; connected ${connected.joinToString().ifBlank { "no lenses" }}"
                }
            )
        }
    }

    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val side = classifyG1Lens(result) ?: return
            val address = result.device.address ?: return
            if (!discoveredAddresses.add(address)) return
            if (gatts.containsKey(side)) return

            val name = result.device.name ?: result.scanRecord?.deviceName ?: address
            onStatusChange?.invoke("Found G1 ${sideLabel(side)} lens: $name — connecting...")
            connectToDevice(result.device, side)

            if (gatts.keys.containsAll(listOf(GlassSide.LEFT, GlassSide.RIGHT))) {
                leScanner?.stopScan(this)
            }
        }

        override fun onScanFailed(errorCode: Int) {
            onStatusChange?.invoke("BLE scan failed: error $errorCode")
        }
    }

    @SuppressLint("MissingPermission")
    fun connectToDevice(device: BluetoothDevice, side: GlassSide) {
        gatts[side]?.close()
        txCharacteristics.remove(side)
        gatts[side] = device.connectGatt(this, false, gattCallback(side), BluetoothDevice.TRANSPORT_LE)
    }

    private fun gattCallback(side: GlassSide) = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    onStatusChange?.invoke("Connected to G1 ${sideLabel(side)} lens — discovering services...")
                    gatt.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    onStatusChange?.invoke("Disconnected from G1 ${sideLabel(side)} lens")
                    txCharacteristics.remove(side)
                    gatts.remove(side)
                    gatt.close()
                }
            }
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                onStatusChange?.invoke("G1 ${sideLabel(side)} service discovery failed: $status")
                return
            }
            val service: BluetoothGattService = gatt.getService(nusServiceUuid) ?: run {
                onStatusChange?.invoke("G1 ${sideLabel(side)} NUS service not found")
                return
            }
            txCharacteristics[side] = service.getCharacteristic(nusTxCharUuid)

            val rxChar = service.getCharacteristic(nusRxCharUuid)
            if (rxChar != null) {
                gatt.setCharacteristicNotification(rxChar, true)
                rxChar.getDescriptor(cccdUuid)?.let { descriptor ->
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(descriptor)
                }
            }

            writeSide(side, connectionReadyPacket(side))
            val connected = connectedSides()
            onStatusChange?.invoke(
                if (connected.size == 2) {
                    "G1 ready — whole headset connected"
                } else {
                    "G1 ${sideLabel(side)} lens ready; waiting for ${missingSides().joinToString()}"
                }
            )
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (characteristic.uuid == nusRxCharUuid) {
                onDataReceived?.invoke(side, characteristic.value ?: return)
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            if (characteristic.uuid == nusRxCharUuid) {
                onDataReceived?.invoke(side, value)
            }
        }
    }

    fun displayText(text: String) {
        val pages = paginateDisplayText(text)
        for ((pageIndex, page) in pages.withIndex()) {
            val status = if (pageIndex == pages.lastIndex) 0x40 else 0x31
            for (packet in encodeTextPackets(page, nextDisplaySeq(), status, pageIndex + 1, pages.size)) {
                writeBoth(packet)
            }
        }
    }

    fun clearDisplay() {
        writeBoth(byteArrayOf(cmdStartAi, 0x18.toByte(), 0x00, 0x00, 0x00))
    }

    fun setBrightness(level: Int, auto: Boolean = false) {
        val clamped = level.coerceIn(0, 0x29).toByte()
        writeBoth(byteArrayOf(cmdBrightness, clamped, (if (auto) 0x01 else 0x00).toByte()))
    }

    fun setMicEnabled(enabled: Boolean) {
        writeSide(GlassSide.RIGHT, byteArrayOf(cmdOpenMic, (if (enabled) 0x01 else 0x00).toByte()))
    }

    fun requestBatteryStatus() {
        writeBoth(byteArrayOf(cmdBattery, 0x01.toByte()))
    }

    fun sendRaw(sideName: String, bytes: ByteArray) {
        when (sideName.lowercase()) {
            "left" -> writeSide(GlassSide.LEFT, bytes)
            "right" -> writeSide(GlassSide.RIGHT, bytes)
            else -> writeBoth(bytes)
        }
    }

    fun sendHeartbeat() {
        val seq = nextHeartbeatSeq().toByte()
        writeBoth(byteArrayOf(cmdHeartbeat, 0x06.toByte(), 0x00, seq, 0x04.toByte(), seq))
    }

    @SuppressLint("MissingPermission")
    fun disconnect() {
        for (gatt in gatts.values) {
            gatt.disconnect()
            gatt.close()
        }
        gatts.clear()
        txCharacteristics.clear()
    }

    private fun classifyG1Lens(result: ScanResult): GlassSide? {
        val name = result.device.name ?: result.scanRecord?.deviceName ?: ""
        val serviceUuids = result.scanRecord?.serviceUuids?.map(ParcelUuid::getUuid).orEmpty()
        val looksLikeG1 = name.contains("Even", ignoreCase = true) ||
            name.contains("G1", ignoreCase = true) ||
            serviceUuids.contains(nusServiceUuid)
        if (!looksLikeG1) return null
        return when {
            name.contains("_L_", ignoreCase = true) || name.endsWith("_L", ignoreCase = true) -> GlassSide.LEFT
            name.contains("_R_", ignoreCase = true) || name.endsWith("_R", ignoreCase = true) -> GlassSide.RIGHT
            else -> null
        }
    }

    private fun connectionReadyPacket(side: GlassSide): ByteArray =
        byteArrayOf(if (side == GlassSide.LEFT) cmdInit else cmdRightInit, 0x01.toByte())

    private fun paginateDisplayText(text: String): List<String> {
        val normalized = text.trim().ifEmpty { " " }
        val words = normalized.split(Regex("\\s+"))
        val lines = mutableListOf<String>()
        var current = ""
        for (word in words) {
            val candidate = if (current.isEmpty()) word else "$current $word"
            if (candidate.length <= 40) {
                current = candidate
            } else {
                if (current.isNotEmpty()) lines.add(current)
                current = word
            }
        }
        if (current.isNotEmpty()) lines.add(current)
        if (lines.isEmpty()) lines.add(" ")
        return lines.chunked(5).map { it.joinToString("\n") }
    }

    private fun encodeTextPackets(
        text: String,
        seq: Int,
        status: Int,
        pageNumber: Int,
        maxPages: Int
    ): List<ByteArray> {
        val bytes = text.toByteArray(Charsets.UTF_8)
        val chunks = splitUtf8Chunks(bytes, 191)
        return chunks.mapIndexed { index, chunk ->
            val charPosition = index * 191
            byteArrayOf(
                cmdSendResult,
                (seq and 0xff).toByte(),
                (chunks.size and 0xff).toByte(),
                (index and 0xff).toByte(),
                (status and 0xff).toByte(),
                ((charPosition ushr 8) and 0xff).toByte(),
                (charPosition and 0xff).toByte(),
                (pageNumber and 0xff).toByte(),
                (maxPages and 0xff).toByte()
            ) + chunk
        }
    }

    private fun splitUtf8Chunks(bytes: ByteArray, maxBytes: Int): List<ByteArray> {
        if (bytes.isEmpty()) return listOf(ByteArray(0))
        val chunks = mutableListOf<ByteArray>()
        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(offset + maxBytes, bytes.size)
            chunks.add(bytes.copyOfRange(offset, end))
            offset = end
        }
        return chunks
    }

    @SuppressLint("MissingPermission")
    private fun writeBoth(bytes: ByteArray) {
        writeSide(GlassSide.LEFT, bytes)
        writeSide(GlassSide.RIGHT, bytes)
    }

    @SuppressLint("MissingPermission")
    private fun writeSide(side: GlassSide, bytes: ByteArray) {
        val char = txCharacteristics[side] ?: run {
            Log.w(tag, "TX characteristic for ${sideLabel(side)} lens not ready — command dropped")
            return
        }
        char.value = bytes
        gatts[side]?.writeCharacteristic(char)
    }

    private fun connectedSides(): Set<GlassSide> = txCharacteristics.keys

    private fun missingSides(): List<String> =
        listOf(GlassSide.LEFT, GlassSide.RIGHT)
            .filterNot { txCharacteristics.containsKey(it) }
            .map(::sideLabel)

    private fun sideLabel(side: GlassSide): String =
        if (side == GlassSide.LEFT) "left" else "right"

    private fun nextDisplaySeq(): Int {
        val seq = displaySeq and 0xff
        displaySeq = (displaySeq + 1) and 0xff
        return seq
    }

    private fun nextHeartbeatSeq(): Int {
        val seq = heartbeatSeq and 0xff
        heartbeatSeq = (heartbeatSeq + 1) and 0xff
        return seq
    }

    override fun onDestroy() {
        scope.cancel()
        disconnect()
        super.onDestroy()
    }
}
