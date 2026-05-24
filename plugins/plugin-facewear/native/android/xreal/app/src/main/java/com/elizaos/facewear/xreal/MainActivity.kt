package com.elizaos.facewear.xreal

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var cameraService: CameraService
    private lateinit var xrealBridge: XrealBridgeJs

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val allGranted = grants.values.all { it }
        if (allGranted) {
            startCamera()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        configureWebView()
        requestRequiredPermissions()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = false
        settings.databaseEnabled = true
        settings.setSupportZoom(false)

        xrealBridge = XrealBridgeJs(this)
        webView.addJavascriptInterface(xrealBridge, "ElizaXreal")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                // Inject device-type hint so the PWA knows it is on XReal
                view.evaluateJavascript(
                    "window.__ELIZA_DEVICE_TYPE__ = 'xreal';",
                    null
                )
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    view.loadUrl("about:blank")
                    view.loadUrl(agentUrl())
                }
            }
        }

        webView.loadUrl(agentUrl())
    }

    private fun agentUrl(): String {
        // Default agent URL — override via Intent extra "AGENT_URL" or build config
        return intent.getStringExtra("AGENT_URL")
            ?: "http://192.168.1.100:31337/xr"
    }

    private fun requestRequiredPermissions() {
        val required = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        )
        val missing = required.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            startCamera()
        } else {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    private fun startCamera() {
        cameraService = CameraService(this, webView)
        cameraService.start()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::cameraService.isInitialized) {
            cameraService.stop()
        }
        if (::xrealBridge.isInitialized) {
            xrealBridge.disconnect()
        }
        webView.destroy()
    }
}
