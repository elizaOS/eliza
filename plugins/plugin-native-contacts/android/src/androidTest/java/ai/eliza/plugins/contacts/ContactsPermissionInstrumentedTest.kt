package ai.eliza.plugins.contacts

import android.Manifest
import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.content.ContentUris
import android.os.Bundle
import android.provider.ContactsContract
import android.util.Base64
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The host revokes only this isolated APK's contacts permissions before preflight. */
@RunWith(AndroidJUnit4::class)
class ContactsPermissionInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val records = JSONArray()

    private fun evaluate(scenario: ActivityScenario<ContactsTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var result = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { value -> result = value; done.countDown() } }
        assertTrue("Contacts WebView callback timed out", done.await(5, TimeUnit.SECONDS))
        return result
    }

    private fun begin(scenario: ActivityScenario<ContactsTestActivity>, method: String, options: JSONObject = JSONObject()) {
        evaluate(scenario, """
            window.permissionResult = null;
            Capacitor.nativePromise('ElizaContacts', '$method', $options)
              .then(value => window.permissionResult = JSON.stringify({value}))
              .catch(error => window.permissionResult = JSON.stringify({error: String(error)}));
        """.trimIndent())
    }

    private fun result(scenario: ActivityScenario<ContactsTestActivity>, stage: String): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            val raw = evaluate(scenario, "window.permissionResult")
            if (raw != "null") {
                val response = JSONObject(JSONTokener(raw).nextValue() as String)
                records.put(JSONObject().put("stage", stage).put("response", response)
                    .put("readGranted", granted(Manifest.permission.READ_CONTACTS))
                    .put("writeGranted", granted(Manifest.permission.WRITE_CONTACTS)))
                return response
            }
            Thread.sleep(25)
        }
        throw AssertionError("Contacts permission bridge did not settle: $stage")
    }

    private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun choosePermission(scenario: ActivityScenario<ContactsTestActivity>, button: String) {
        val device = UiDevice.getInstance(instrumentation)
        val target = device.wait(Until.findObject(By.res("com.android.permissioncontroller", button)), 10000)
        if (target == null) {
            // Preserve the actual bridge response even if Android settled without
            // displaying a dialog. A missing button alone hides that distinction.
            val pending = evaluate(scenario, "window.permissionResult")
            val window = java.io.ByteArrayOutputStream().also { device.dumpWindowHierarchy(it) }
            records.put(JSONObject().put("stage", "permission-dialog-missing")
                .put("button", button).put("bridgeResponse", if (pending == "null") JSONObject.NULL else JSONObject(JSONTokener(pending).nextValue() as String))
                .put("readGranted", granted(Manifest.permission.READ_CONTACTS))
                .put("writeGranted", granted(Manifest.permission.WRITE_CONTACTS))
                .put("windowHierarchy", window.toString("UTF-8")))
        }
        assertNotNull("Android contacts permission button missing: $button", target)
        requireNotNull(target).click()
    }

    @Test fun permissionStateAndRecovery() {
        val preflight = InstrumentationRegistry.getArguments().getString("contactsPermissionPreflight") == "1"
        assertTrue("Only isolated contacts test APK may change permissions", context.packageName.endsWith(".test"))
        if (preflight) {
            assertFalse("Host must revoke READ_CONTACTS before preflight", granted(Manifest.permission.READ_CONTACTS))
            assertFalse("Host must revoke WRITE_CONTACTS before preflight", granted(Manifest.permission.WRITE_CONTACTS))
        }
        val marker = "ElizaDeniedContact${UUID.randomUUID().toString().replace("-", "")}"
        try {
            ActivityScenario.launch(ContactsTestActivity::class.java).use { scenario ->
                val keyguard = context.getSystemService(KeyguardManager::class.java)
                assertFalse("Permission tests require an unsecured emulator", keyguard.isKeyguardSecure)
                UiDevice.getInstance(instrumentation).wakeUp()
                scenario.onActivity { keyguard.requestDismissKeyguard(it, null) }
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (keyguard.isKeyguardLocked || evaluate(scenario, "Boolean(window.Capacitor?.nativePromise)") != "true") {
                    assertTrue("Contacts bridge/unlocked screen unavailable", System.nanoTime() < deadline)
                    Thread.sleep(25)
                }
                if (preflight) {
                    begin(scenario, "checkPermissions")
                    assertNotEquals("granted", result(scenario, "initial").getJSONObject("value").getString("contacts"))
                    begin(scenario, "requestPermissions")
                    choosePermission(scenario, "permission_deny_button")
                    assertNotEquals("granted", result(scenario, "user-denied").getJSONObject("value").getString("contacts"))
                    assertFalse(granted(Manifest.permission.READ_CONTACTS))
                    assertFalse(granted(Manifest.permission.WRITE_CONTACTS))
                    for ((method, options) in listOf(
                        "listContacts" to JSONObject().put("query", marker),
                        "createContact" to JSONObject().put("displayName", marker),
                        "importVCard" to JSONObject().put("vcardText", "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:$marker\r\nEND:VCARD")
                    )) {
                        begin(scenario, method, options)
                        val denied = result(scenario, "denied-$method")
                        assertFalse("Denied operation fabricated a value: $denied", denied.has("value"))
                        assertTrue("Permission rejection missing: $denied", denied.getString("error").contains("CONTACTS permission is required"))
                    }
                    begin(scenario, "requestPermissions")
                    choosePermission(scenario, "permission_allow_button")
                    assertEquals("granted", result(scenario, "user-granted").getJSONObject("value").getString("contacts"))
                }
                assertTrue(granted(Manifest.permission.READ_CONTACTS))
                assertTrue(granted(Manifest.permission.WRITE_CONTACTS))
                begin(scenario, "checkPermissions")
                assertEquals("granted", result(scenario, "granted-check").getJSONObject("value").getString("contacts"))
                begin(scenario, "listContacts", JSONObject().put("query", marker))
                assertEquals("Denied mutations must not create contacts", 0,
                    result(scenario, "recovered-read").getJSONObject("value").getJSONArray("contacts").length())
            }
        } finally {
            try {
                // If a regression permits a denied write, remove only this run's
                // exact synthetic name after access has been granted again.
                if (granted(Manifest.permission.READ_CONTACTS) && granted(Manifest.permission.WRITE_CONTACTS)) {
                    val resolver = context.contentResolver
                    val rawIds = requireNotNull(resolver.query(ContactsContract.Data.CONTENT_URI,
                        arrayOf(ContactsContract.Data.RAW_CONTACT_ID),
                        "${ContactsContract.Data.MIMETYPE} = ? AND ${ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME} = ?",
                        arrayOf(ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE, marker), null)).use { cursor ->
                        buildSet { while (cursor.moveToNext()) add(cursor.getLong(0)) }
                    }
                    for (id in rawIds) assertEquals(1, resolver.delete(ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, id), null, null))
                    records.put(JSONObject().put("stage", "cleanup").put("ownedRawIdsRemoved", JSONArray(rawIds.toList())))
                }
            } finally {
                instrumentation.sendStatus(2, Bundle().apply {
                    putString("nativeArtifactName", if (preflight) "contacts-permissions-preflight.json" else "contacts-permissions-granted.json")
                    putString("nativeArtifactBase64", Base64.encodeToString(records.toString(2).toByteArray(), Base64.NO_WRAP))
                })
            }
        }
    }
}
