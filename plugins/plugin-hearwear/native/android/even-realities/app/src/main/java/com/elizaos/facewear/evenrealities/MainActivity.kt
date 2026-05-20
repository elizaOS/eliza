package com.elizaos.facewear.evenrealities

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private var g1Service: G1BleService? = null
    private var agentBridge: AgentBridgeService? = null
    private var servicesBound = false

    private lateinit var statusText: TextView
    private lateinit var agentUrlInput: EditText
    private lateinit var connectButton: Button
    private lateinit var scanButton: Button

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val allGranted = grants.values.all { it }
        updateStatus(if (allGranted) "Permissions granted — tap Scan to find G1" else "Permissions denied")
    }

    private val g1Connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            g1Service = (binder as G1BleService.LocalBinder).service
            g1Service?.onStatusChange = { status -> runOnUiThread { updateStatus(status) } }
        }
        override fun onServiceDisconnected(name: ComponentName) { g1Service = null }
    }

    private val agentConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            agentBridge = (binder as AgentBridgeService.LocalBinder).service
            agentBridge?.onStatusChange = { status -> runOnUiThread { updateStatus(status) } }
        }
        override fun onServiceDisconnected(name: ComponentName) { agentBridge = null }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Minimal programmatic layout — replace with XML layout for production
        val layout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
        }

        statusText = TextView(this).apply { text = "Even Realities G1 Bridge — idle" }
        agentUrlInput = EditText(this).apply {
            hint = "Agent WebSocket URL (ws://192.168.1.100:31337/xr-ws)"
            setText("ws://192.168.1.100:31337/xr-ws")
        }
        scanButton = Button(this).apply {
            text = "Scan for G1"
            setOnClickListener { startG1Scan() }
        }
        connectButton = Button(this).apply {
            text = "Connect to Agent"
            setOnClickListener { connectToAgent() }
        }

        layout.addView(statusText)
        layout.addView(agentUrlInput)
        layout.addView(scanButton)
        layout.addView(connectButton)
        setContentView(layout)

        requestRequiredPermissions()
        bindServices()
    }

    private fun requestRequiredPermissions() {
        val required = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_CONNECT)
                add(Manifest.permission.BLUETOOTH_SCAN)
            }
        }
        val missing = required.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) permissionLauncher.launch(missing.toTypedArray())
    }

    private fun bindServices() {
        bindService(Intent(this, G1BleService::class.java), g1Connection, Context.BIND_AUTO_CREATE)
        bindService(Intent(this, AgentBridgeService::class.java), agentConnection, Context.BIND_AUTO_CREATE)
        servicesBound = true
    }

    private fun startG1Scan() {
        val btManager = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        if (!btManager.adapter.isEnabled) {
            updateStatus("Bluetooth is off — enable it and try again")
            return
        }
        g1Service?.startScan() ?: updateStatus("BLE service not ready")
    }

    private fun connectToAgent() {
        val url = agentUrlInput.text.toString().trim()
        if (url.isEmpty()) return
        agentBridge?.connect(url) ?: updateStatus("Agent bridge not ready")
    }

    private fun updateStatus(msg: String) {
        statusText.text = msg
    }

    override fun onDestroy() {
        super.onDestroy()
        if (servicesBound) {
            unbindService(g1Connection)
            unbindService(agentConnection)
        }
    }
}
