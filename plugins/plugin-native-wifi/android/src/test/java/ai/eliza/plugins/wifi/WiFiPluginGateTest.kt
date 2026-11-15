package ai.eliza.plugins.wifi

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** JVM tests for the host gate: run with `./gradlew :elizaos-plugin-native-wifi:testDebugUnitTest`. */
class WiFiPluginGateTest {
    /** A host build that must never scan, join or ask for location. */
    private class DisabledHost : WiFiPlugin() {
        override fun enabled() = false
    }

    /** Records the answer instead of sending it to a WebView. */
    private class RecordedCall(data: JSObject) : PluginCall(null, "ElizaWiFi", "1", "method", data) {
        var code: String? = null
        var resolved = false

        override fun reject(msg: String?, code: String?, ex: Exception?, data: JSObject?) {
            this.code = code
        }

        override fun resolve(data: JSObject?) {
            resolved = true
        }

        override fun resolve() {
            resolved = true
        }
    }

    @Test
    fun disabledHost_refusesEveryBridgeMethod() {
        // The methods Capacitor exposes for this class, found the way Capacitor finds them.
        val methods = WiFiPlugin::class.java.methods.filter {
            it.declaringClass == WiFiPlugin::class.java && it.isAnnotationPresent(PluginMethod::class.java)
        }
        assertTrue(
            methods.map { it.name }.containsAll(
                listOf(
                    "checkPermissions", "requestPermissions", "getCapabilities", "openInternetPanel",
                    "getWifiState", "getConnectedNetwork", "listAvailableNetworks", "connectToNetwork",
                    "disconnectFromNetwork", "getConnectivity", "addNetworkWithApproval",
                ),
            ),
        )
        for (method in methods) {
            val call = RecordedCall(JSObject().put("ssid", "cafe").put("password", "cafe-secret"))
            method.invoke(DisabledHost(), call)
            assertEquals(method.name, "DISABLED", call.code)
            assertFalse(method.name, call.resolved)
        }
    }

    @Test
    fun disabledHost_dropsTheApprovedJoinPassword() {
        val call = RecordedCall(JSObject().put("ssid", "cafe").put("password", "cafe-secret"))
        DisabledHost().addNetworkWithApproval(call)
        assertEquals("DISABLED", call.code)
        assertFalse(call.data.has("password"))
    }
}
