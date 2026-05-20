package com.elizaos.facewear.evenrealities

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
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * BLE GATT service that connects to Even Realities G1 glasses.
 *
 * G1 BLE profile uses the Nordic UART Service (NUS):
 *   Service UUID:   6e400001-b5a3-f393-e0a9-e50e24dcca9e
 *   TX (write):     6e400002-b5a3-f393-e0a9-e50e24dcca9e  (phone → glasses)
 *   RX (notify):    6e400003-b5a3-f393-e0a9-e50e24dcca9e  (glasses → phone)
 *
 * Command format (from Even Realities SDK / BLE sniffing):
 *   Byte 0: command byte
 *   Byte 1+: payload
 *
 * Known command bytes:
 *   0x4E - display text (followed by UTF-8 string, max ~250 bytes per packet)
 *   0x06 - clear display
 *   0x4B - set brightness (byte 1 = 0x01-0x06)
 *   0x26 - mic enable/disable (byte 1 = 0x01/0x00)
 *
 * Note: Even Realities does not publish an official BLE SDK. The protocol above
 * is derived from community reverse engineering. Check https://github.com/even-realities/
 * for any official SDK updates.
 */
class G1BleService : Service() {

    private val TAG = "G1BleService"

    // Nordic UART Service UUIDs
    private val NUS_SERVICE_UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
    private val NUS_TX_CHAR_UUID = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
    private val NUS_RX_CHAR_UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
    private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    // Command bytes
    private val CMD_DISPLAY_TEXT: Byte = 0x4E.toByte()
    private val CMD_CLEAR_DISPLAY: Byte = 0x06.toByte()
    private val CMD_SET_BRIGHTNESS: Byte = 0x4B.toByte()
    private val CMD_MIC_CONTROL: Byte = 0x26.toByte()

    private val binder = LocalBinder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var leScanner: BluetoothLeScanner? = null
    private var gatt: BluetoothGatt? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null

    var onStatusChange: ((String) -> Unit)? = null
    var onDataReceived: ((ByteArray) -> Unit)? = null

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

    fun startScan() {
        val scanner = leScanner ?: run {
            onStatusChange?.invoke("Bluetooth LE scanner not available")
            return
        }
        onStatusChange?.invoke("Scanning for G1 glasses...")

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        // Filter by NUS service UUID to find G1 specifically
        val filters = listOf(
            ScanFilter.Builder()
                .setServiceUuid(android.os.ParcelUuid(NUS_SERVICE_UUID))
                .build()
        )

        scanner.startScan(filters, settings, scanCallback)

        // Auto-stop scan after 15 seconds
        scope.launch {
            kotlinx.coroutines.delay(15_000)
            scanner.stopScan(scanCallback)
            onStatusChange?.invoke("Scan complete")
        }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            leScanner?.stopScan(this)
            val device = result.device
            onStatusChange?.invoke("Found G1: ${device.name ?: device.address} — connecting…")
            connectToDevice(device)
        }

        override fun onScanFailed(errorCode: Int) {
            onStatusChange?.invoke("BLE scan failed: error $errorCode")
        }
    }

    fun connectToDevice(device: BluetoothDevice) {
        gatt?.close()
        gatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    onStatusChange?.invoke("Connected to G1 — discovering services…")
                    gatt.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    onStatusChange?.invoke("Disconnected from G1")
                    txCharacteristic = null
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                onStatusChange?.invoke("Service discovery failed: $status")
                return
            }
            val service: BluetoothGattService = gatt.getService(NUS_SERVICE_UUID) ?: run {
                onStatusChange?.invoke("G1 NUS service not found — wrong device?")
                return
            }
            txCharacteristic = service.getCharacteristic(NUS_TX_CHAR_UUID)

            // Enable notifications on RX characteristic (glasses → phone)
            val rxChar = service.getCharacteristic(NUS_RX_CHAR_UUID)
            if (rxChar != null) {
                gatt.setCharacteristicNotification(rxChar, true)
                val descriptor = rxChar.getDescriptor(CCCD_UUID)
                descriptor?.let {
                    it.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(it)
                }
            }
            onStatusChange?.invoke("G1 ready — NUS service connected")
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (characteristic.uuid == NUS_RX_CHAR_UUID) {
                onDataReceived?.invoke(characteristic.value ?: return)
            }
        }
    }

    /** Display up to 250 bytes of UTF-8 text on the G1 display. */
    fun displayText(text: String) {
        val payload = text.toByteArray(Charsets.UTF_8).take(250)
        val cmd = byteArrayOf(CMD_DISPLAY_TEXT) + payload.toByteArray()
        writeCommand(cmd)
    }

    /** Clear the G1 display. */
    fun clearDisplay() {
        writeCommand(byteArrayOf(CMD_CLEAR_DISPLAY))
    }

    /** Set display brightness (1–6). */
    fun setBrightness(level: Int) {
        val clamped = level.coerceIn(1, 6).toByte()
        writeCommand(byteArrayOf(CMD_SET_BRIGHTNESS, clamped))
    }

    /** Enable or disable the G1 microphone. */
    fun setMicEnabled(enabled: Boolean) {
        writeCommand(byteArrayOf(CMD_MIC_CONTROL, if (enabled) 0x01 else 0x00))
    }

    @Suppress("DEPRECATION")
    private fun writeCommand(bytes: ByteArray) {
        val char = txCharacteristic ?: run {
            Log.w(TAG, "TX characteristic not ready — command dropped")
            return
        }
        char.value = bytes
        gatt?.writeCharacteristic(char)
    }

    override fun onDestroy() {
        scope.cancel()
        gatt?.close()
        gatt = null
        super.onDestroy()
    }
}
