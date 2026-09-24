package ai.eliza.plugins.location

import android.Manifest
import android.content.Context
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.Tasks
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Deterministic provider -> production reader round trips, including AOSP. */
@RunWith(AndroidJUnit4::class)
class LocationFixReaderInstrumentedTest {
    @get:Rule
    val permissionRule: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION,
    )
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext

    private fun fix() = Location(LocationManager.GPS_PROVIDER).apply {
        latitude = 37.7749
        longitude = -122.4194
        accuracy = 2f
        time = System.currentTimeMillis()
        elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
    }

    private fun withProvider(block: (LocationManager) -> Unit) {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        instrumentation.uiAutomation.executeShellCommand("appops set ${context.packageName} android:mock_location allow").use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes()
        }
        @Suppress("DEPRECATION")
        manager.addTestProvider(LocationManager.GPS_PROVIDER, false, false, false, false, true, true, true, Criteria.POWER_LOW, Criteria.ACCURACY_FINE)
        try {
            manager.setTestProviderEnabled(LocationManager.GPS_PROVIDER, true)
            block(manager)
        } finally {
            manager.removeTestProvider(LocationManager.GPS_PROVIDER)
        }
    }

    @Test
    fun mapAccuracyToPriority_coversEveryTier() {
        val reader = LocationFixReader(context)
        try {
            assertEquals(Priority.PRIORITY_HIGH_ACCURACY, reader.mapAccuracyToPriority("best"))
            assertEquals(Priority.PRIORITY_HIGH_ACCURACY, reader.mapAccuracyToPriority("high"))
            assertEquals(Priority.PRIORITY_BALANCED_POWER_ACCURACY, reader.mapAccuracyToPriority("medium"))
            assertEquals(Priority.PRIORITY_LOW_POWER, reader.mapAccuracyToPriority("low"))
            assertEquals(Priority.PRIORITY_PASSIVE, reader.mapAccuracyToPriority("passive"))
        } finally { reader.close() }
    }

    @Test
    fun awaitNextLocation_readsBackAnInjectedFixWithoutSkipping() = withProvider { manager ->
        val reader = LocationFixReader(context)
        val fused = LocationServices.getFusedLocationProviderClient(context)
        val executor = Executors.newSingleThreadScheduledExecutor()
        val failure = AtomicReference<Exception?>()
        try {
            if (!reader.usesFrameworkLocation) Tasks.await(fused.setMockMode(true), 5, TimeUnit.SECONDS)
            executor.scheduleAtFixedRate({
                try {
                    if (reader.usesFrameworkLocation) manager.setTestProviderLocation(LocationManager.GPS_PROVIDER, fix())
                    else Tasks.await(fused.setMockLocation(fix()), 5, TimeUnit.SECONDS)
                } catch (error: Exception) { failure.set(error) }
            }, 100, 100, TimeUnit.MILLISECONDS)
            val location = reader.awaitNextLocation("high", 5000)
            failure.get()?.let { throw it }
            assertNotNull("the production location backend must deliver the injected fix", location)
            assertEquals(37.7749, location!!.latitude, 0.00001)
            assertEquals(-122.4194, location.longitude, 0.00001)
            assertTrue(location.elapsedRealtimeNanos > 0)
        } finally {
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
            if (!reader.usesFrameworkLocation) Tasks.await(fused.setMockMode(false), 5, TimeUnit.SECONDS)
            reader.close()
        }
    }

    @Test
    fun frameworkWatchDeliversCoordinatesAndStopsAfterClose() = withProvider { manager ->
        val provider = AndroidLocationProvider(context)
        val first = CountDownLatch(1)
        val afterClose = CountDownLatch(1)
        var closed = false
        val failure = AtomicReference<Exception?>()
        val received = AtomicReference<Location?>()
        val watch = provider.watch(Priority.PRIORITY_HIGH_ACCURACY, 0, 0f, {
            received.set(it)
            if (closed) afterClose.countDown() else first.countDown()
        }, { failure.set(it) })
        try {
            manager.setTestProviderLocation(LocationManager.GPS_PROVIDER, fix())
            assertTrue("framework watch must receive a fix", first.await(5, TimeUnit.SECONDS))
            assertEquals(37.7749, received.get()!!.latitude, 0.00001)
            instrumentation.runOnMainSync { watch.close(); closed = true }
            manager.setTestProviderLocation(LocationManager.GPS_PROVIDER, fix().apply { latitude = 38.0 })
            assertFalse("closed watch must not deliver events", afterClose.await(500, TimeUnit.MILLISECONDS))
            failure.get()?.let { throw it }
        } finally { watch.close(); provider.close() }
    }

    @Test
    fun frameworkFreshRequestTimesOutAndDestroyCancelsPendingRequest() = withProvider { _ ->
        val provider = AndroidLocationProvider(context)
        try {
            assertNull(Tasks.await(provider.current(Priority.PRIORITY_HIGH_ACCURACY, 150, 0), 3, TimeUnit.SECONDS))
            val pending = provider.current(Priority.PRIORITY_HIGH_ACCURACY, 5000, 0)
            provider.close()
            val error = assertThrows(java.util.concurrent.ExecutionException::class.java) {
                Tasks.await(pending, 3, TimeUnit.SECONDS)
            }
            assertTrue(error.cause is IllegalStateException)
        } finally { provider.close() }
    }
}
