package ai.eliza.plugins.appblocker

import android.content.Context
import android.content.Intent
import java.io.File
import android.os.ParcelFileDescriptor
import org.junit.Rule
import org.junit.rules.TestName
import java.io.ByteArrayOutputStream
import org.junit.Before
import org.junit.After
import android.graphics.Point
import org.json.JSONArray
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.getcapacitor.BridgeActivity
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Drives the production usage-event monitor and overlay against an independent app. */
class AppBlockerBridgeTestActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(AppBlockerPlugin::class.java)
        if (Build.VERSION.SDK_INT >= 27) { setTurnScreenOn(true); setShowWhenLocked(true) }
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

@RunWith(AndroidJUnit4::class)
class AppBlockerBridgeInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val device get() = UiDevice.getInstance(instrumentation)

    private fun evaluate(scenario: ActivityScenario<AppBlockerBridgeTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var value = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { result -> value = result; done.countDown() } }
        assertTrue("WebView evaluation timed out", done.await(5, TimeUnit.SECONDS))
        return value
    }

    private fun begin(scenario: ActivityScenario<AppBlockerBridgeTestActivity>, method: String, options: JSONObject = JSONObject()) {
        evaluate(scenario, """
            window.result = null;
            window.Capacitor.nativePromise('ElizaAppBlocker', '$method', $options)
              .then(value => window.result = JSON.stringify({value: value ?? {}}))
              .catch(error => window.result = JSON.stringify({error: String(error)}));
        """.trimIndent())
    }

    private fun result(scenario: ActivityScenario<AppBlockerBridgeTestActivity>): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            val raw = evaluate(scenario, "window.result")
            if (raw != "null") {
                val parsed = JSONObject(JSONTokener(raw).nextValue() as String)
                assertFalse("Native blocker rejected: $parsed", parsed.has("error"))
                return parsed.getJSONObject("value")
            }
            Thread.sleep(30)
        }
        throw AssertionError("App blocker promise did not settle")
    }

    private fun ready(scenario: ActivityScenario<AppBlockerBridgeTestActivity>) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)") != "true") {
            assertTrue("Capacitor initialization timed out", System.nanoTime() < deadline)
            Thread.sleep(20)
        }
        begin(scenario, "getInstalledApps")
        val apps = result(scenario).getJSONArray("apps")
        assertTrue("Native app discovery must include the independent launcher app",
            (0 until apps.length()).any { apps.getJSONObject(it).getString("packageName") == target })
    }

    private fun export(name: String, bytes: ByteArray) {
        instrumentation.sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        })
    }

    @get:Rule val testName = TestName()
    private val target = "ai.eliza.testing.blocktarget"

    private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(
        instrumentation.uiAutomation.executeShellCommand(command)
    ).bufferedReader().use { it.readText() }

    @Before fun grantFixturePermissions() {
        val name = instrumentation.targetContext.packageName
        shell("appops set $name GET_USAGE_STATS allow")
        shell("appops set $name SYSTEM_ALERT_WINDOW allow")
        shell("pm clear $target")
    }

    @After fun cleanFixturePermissions() {
        try {
            val tree = ByteArrayOutputStream()
            device.dumpWindowHierarchy(tree)
            export("${testName.methodName}-ui.txt", tree.toByteArray())
            capture("${testName.methodName}-screen.png")
        } finally {
            val context = instrumentation.targetContext
            AppBlockerStateStore.clear(context)
            context.stopService(Intent(context, AppBlockerForegroundService::class.java))
            shell("appops set ${context.packageName} GET_USAGE_STATS default")
            shell("appops set ${context.packageName} SYSTEM_ALERT_WINDOW default")
            device.pressHome()
        }
    }

    private fun launchTarget() {
        instrumentation.targetContext.startActivity(Intent(Intent.ACTION_MAIN)
            .setClassName(target, "$target.TargetActivity")
            .addCategory(Intent.CATEGORY_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun capture(name: String) {
        val file = File(instrumentation.targetContext.cacheDir, name)
        assertTrue(device.takeScreenshot(file))
        export(name, file.readBytes())
        file.delete()
    }

    private fun block(scenario: ActivityScenario<AppBlockerBridgeTestActivity>, packageName: String) {
        begin(scenario, "blockApps", JSONObject().put("packageNames", JSONArray().put(packageName)))
        assertTrue(result(scenario).getBoolean("success"))
    }

    @Test
    fun shieldInterceptsTapsAndUnblockRestoresInteraction() {
        ActivityScenario.launch(AppBlockerBridgeTestActivity::class.java).use { scenario ->
            ready(scenario)
            begin(scenario, "checkPermissions")
            assertEquals("granted", result(scenario).getString("status"))
            launchTarget()
            val button = device.wait(Until.findObject(By.text("Tap count: 0")), 5000)!!
            val bounds = button.visibleBounds
            val point = Point(bounds.centerX(), bounds.centerY())
            button.click()
            assertTrue(device.wait(Until.hasObject(By.text("Tap count: 1")), 3000))
            scenario.onActivity { it.startActivity(Intent(it, AppBlockerBridgeTestActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)) }
            block(scenario, target)
            launchTarget()
            assertTrue("Real blocking shield missing", device.wait(Until.hasObject(By.text("App Blocked")), 6000))
            capture("app-blocking-shield.png")
            device.click(point.x, point.y)
            device.findObject(By.text(java.util.regex.Pattern.compile("go home", java.util.regex.Pattern.CASE_INSENSITIVE))).click()
            assertTrue("Shield must release the launcher", device.wait(Until.gone(By.text("App Blocked")), 4000))
            begin(scenario, "unblockApps")
            assertTrue(result(scenario).getBoolean("success"))
            launchTarget()
            assertTrue("Blocked tap reached the target", device.wait(Until.hasObject(By.text("Tap count: 1")), 4000))
            device.findObject(By.text("Tap count: 1")).click()
            assertTrue(device.wait(Until.hasObject(By.text("Tap count: 2")), 3000))
            capture("app-unblocked.png")
        }
    }

    @Test
    fun updatedPolicyBlocksAnAppAlreadyInForeground() {
        ActivityScenario.launch(AppBlockerBridgeTestActivity::class.java).use { scenario ->
            ready(scenario)
            block(scenario, "ai.eliza.testing.notinstalled")
            launchTarget()
            assertTrue(device.wait(Until.hasObject(By.text("Tap count: 0")), 5000))
            Thread.sleep(3000)
            block(scenario, target)
            assertTrue("Policy update must enforce against the current foreground app", device.wait(Until.hasObject(By.text("App Blocked")), 6000))
            capture("app-live-policy-shield.png")
        }
    }

    @Test
    fun replacingTimedBlockDoesNotExpireTheNewBlock() {
        ActivityScenario.launch(AppBlockerBridgeTestActivity::class.java).use { scenario ->
            ready(scenario)
            begin(scenario, "blockApps", JSONObject().put("packageNames", JSONArray().put(target)).put("durationMinutes", 1))
            val timed = result(scenario)
            assertTrue(timed.getBoolean("success"))
            val oldDeadline = java.time.Instant.parse(timed.getString("endsAt")).toEpochMilli()
            launchTarget()
            assertTrue(device.wait(Until.hasObject(By.text("App Blocked")), 6000))
            block(scenario, target)
            val waitMs = oldDeadline - System.currentTimeMillis() + 1500
            assertTrue("Unexpected one-minute deadline: $waitMs", waitMs in 1..65000)
            Thread.sleep(waitMs)
            assertTrue("Replacement shield disappeared at the old deadline", device.hasObject(By.text("App Blocked")))
            capture("app-replaced-timer-shield.png")
            // A stopped WebView may be frozen after a minute. Inspect the shield
            // first, then bring the host forward before querying its JS bridge.
            scenario.onActivity { it.startActivity(Intent(it, AppBlockerBridgeTestActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)) }
            assertTrue(device.wait(Until.hasObject(By.text("Real Android native bridge contracts")), 5000))
            begin(scenario, "getStatus")
            assertTrue("Old timer cleared a replacement block", result(scenario).getBoolean("active"))
            export("app-replaced-timer.json", JSONObject().put("oldDeadline", oldDeadline).put("verifiedAt", System.currentTimeMillis()).put("active", true).toString(2).toByteArray())
        }
    }


    @Test
    fun withdrawingAndRestoringUsageAccessReleasesAndRestoresShield() {
        ActivityScenario.launch(AppBlockerBridgeTestActivity::class.java).use { scenario ->
            ready(scenario)
            block(scenario, target)
            launchTarget()
            assertTrue(device.wait(Until.hasObject(By.text("App Blocked")), 6000))
            val ownPackage = instrumentation.targetContext.packageName
            shell("appops set $ownPackage GET_USAGE_STATS default")
            assertTrue("Revoked access must release the shield", device.wait(Until.gone(By.text("App Blocked")), 4000))
            begin(scenario, "getStatus")
            assertFalse("Missing permission must not report active enforcement", result(scenario).getBoolean("active"))
            Thread.sleep(3000)
            shell("appops set $ownPackage GET_USAGE_STATS allow")
            assertTrue("Restored access must detect the already-open app", device.wait(Until.hasObject(By.text("App Blocked")), 6000))
            begin(scenario, "getStatus")
            assertTrue(result(scenario).getBoolean("active"))
            capture("app-restored-permission-shield.png")
        }
    }

}
