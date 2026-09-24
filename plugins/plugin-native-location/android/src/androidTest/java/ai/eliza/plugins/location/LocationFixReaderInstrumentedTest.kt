/**
 * Exercises production framework location requests on an Android emulator.
 * A real LocationManager test provider supplies fixes; no Google services,
 * external GPS injection, skipped assertions or mocked readers are involved.
 */
package ai.eliza.plugins.location

import android.Manifest
import android.content.Context
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LocationFixReaderInstrumentedTest {
    @get:Rule
    val permissionRule = GrantPermissionRule.grant(
        Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION,
    )
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val manager get() = context.getSystemService(LocationManager::class.java)
    private val reader get() = LocationFixReader(context)
    private val handles = mutableListOf<LocationFixReader.RequestHandle>()
    private var providerAdded = false

    @Before
    fun createProvider() {
        check(Build.HARDWARE.contains("cutf") || Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish")) {
            "Framework location fixture requires a disposable emulator"
        }
        shell("appops set ${context.packageName} android:mock_location allow")
        check(manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) { "Enable emulator location before this test" }
        @Suppress("DEPRECATION")
        manager.addTestProvider(LocationManager.GPS_PROVIDER, false, true, false, false, true, true, true,
            Criteria.POWER_LOW, Criteria.ACCURACY_FINE)
        providerAdded = true
        manager.setTestProviderEnabled(LocationManager.GPS_PROVIDER, true)
    }

    @After
    fun cleanup() {
        instrumentation.runOnMainSync { handles.forEach { it.cancel() } }
        if (providerAdded) manager.removeTestProvider(LocationManager.GPS_PROVIDER)
        shell("appops set ${context.packageName} android:mock_location default")
    }

    @Test
    fun currentFixAndCacheReadBackExactFrameworkCoordinates() {
        val delivered = CountDownLatch(1)
        val result = AtomicReference<Location>()
        instrumentation.runOnMainSync {
            handles += reader.getCurrentPosition("high", 3000, 0, { fix, cached ->
                assertFalse(cached)
                result.set(fix)
                delivered.countDown()
            }, { code, message -> fail("$code: $message") })
        }
        inject(37.4219999)
        assertTrue("Framework fix must be delivered", delivered.await(4, TimeUnit.SECONDS))
        assertEquals(37.4219999, result.get().latitude, 0.000001)
        assertEquals(-122.0840575, result.get().longitude, 0.000001)
        val cachedResult = CountDownLatch(1)
        instrumentation.runOnMainSync {
            handles += reader.getCurrentPosition("high", 3000, 60000, { fix, cached ->
                assertTrue(cached)
                assertEquals(result.get().latitude, fix.latitude, 0.000001)
                cachedResult.countDown()
            }, { code, message -> fail("$code: $message") })
        }
        assertTrue("Cached read must settle", cachedResult.await(1, TimeUnit.SECONDS))
    }

    @Test
    fun timeoutSettlesOnceAndRemovesTheListener() {
        val settled = CountDownLatch(1)
        val callbacks = AtomicInteger()
        instrumentation.runOnMainSync {
            handles += reader.getCurrentPosition("high", 100, 0, { _, _ ->
                callbacks.incrementAndGet()
                fail("No fix was injected before timeout")
            }, { code, _ ->
                assertEquals("TIMEOUT", code)
                callbacks.incrementAndGet()
                settled.countDown()
            })
        }
        assertTrue(settled.await(2, TimeUnit.SECONDS))
        inject(38.0)
        instrumentation.waitForIdleSync()
        SystemClock.sleep(200)
        assertEquals(1, callbacks.get())
    }

    @Test
    fun watchDeliversUpdatesAndCancellationStopsDelivery() {
        val delivered = CountDownLatch(1)
        val callbacks = AtomicInteger()
        lateinit var watch: LocationFixReader.RequestHandle
        instrumentation.runOnMainSync {
            watch = reader.watchPosition("high", 0, 0f, {
                callbacks.incrementAndGet()
                delivered.countDown()
            }, { fail(it) })
            handles += watch
        }
        inject(36.0)
        assertTrue(delivered.await(3, TimeUnit.SECONDS))
        instrumentation.runOnMainSync { watch.cancel(); watch.cancel() }
        val count = callbacks.get()
        inject(35.0)
        SystemClock.sleep(200)
        instrumentation.waitForIdleSync()
        assertEquals(count, callbacks.get())
    }

    @Test
    fun invalidDurationsRejectBeforeRegistering() {
        instrumentation.runOnMainSync {
            assertThrows(IllegalArgumentException::class.java) {
                reader.getCurrentPosition("high", 0, 0, { _, _ -> fail() }, { _, _ -> fail() })
            }
            assertThrows(IllegalArgumentException::class.java) {
                reader.watchPosition("high", -1, 0f, { fail() }, { fail() })
            }
        }
    }

    private fun inject(latitude: Double) {
        manager.setTestProviderLocation(LocationManager.GPS_PROVIDER, Location(LocationManager.GPS_PROVIDER).apply {
            this.latitude = latitude
            longitude = -122.0840575
            accuracy = 1f
            time = System.currentTimeMillis()
            elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
        })
    }

    private fun shell(command: String) {
        instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
            java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }
        }
    }
}
