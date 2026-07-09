/**
 * JVM unit tests for the device RAM-tier policy (#14390): marketed-GB recovery
 * from raw totalMem readings and the 4/8 GB agent floors, pinned against
 * real observed device readings.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DeviceRamTierPolicyTest {

    private static long kb(long kiloBytes) {
        return kiloBytes * 1024L;
    }

    private static long gib(double gibibytes) {
        return (long) (gibibytes * (1L << 30));
    }

    @Test
    public void marketedGbRecoversTheAdvertisedSizeFromKernelReducedReadings() {
        // Moto G Play 2024, the #14390 device: /proc/meminfo MemTotal 3,747,844 kB.
        assertEquals(4, DeviceRamTierPolicy.marketedRamGb(kb(3_747_844)));
        // 6 GB-nominal (Pixel 6a class reports ~5.7 GiB usable).
        assertEquals(6, DeviceRamTierPolicy.marketedRamGb(gib(5.7)));
        // 8 GB-nominal phones report ~7.2-7.6 GiB.
        assertEquals(8, DeviceRamTierPolicy.marketedRamGb(gib(7.2)));
        assertEquals(8, DeviceRamTierPolicy.marketedRamGb(gib(7.6)));
        // 12 / 16 GB-nominal.
        assertEquals(12, DeviceRamTierPolicy.marketedRamGb(gib(11.3)));
        assertEquals(16, DeviceRamTierPolicy.marketedRamGb(gib(15.2)));
        // An exact power-of-two reading (emulator) is not rounded past itself.
        assertEquals(8, DeviceRamTierPolicy.marketedRamGb(gib(8.0)));
    }

    @Test
    public void unreadableTotalMemIsUnknownNotZero() {
        assertEquals(-1, DeviceRamTierPolicy.marketedRamGb(0L));
        assertEquals(-1, DeviceRamTierPolicy.marketedRamGb(-1L));
    }

    @Test
    public void localAgentFloorIsEightMarketedGb() {
        assertFalse(DeviceRamTierPolicy.allowsLocalAgent(kb(3_747_844)));
        assertFalse(DeviceRamTierPolicy.allowsLocalAgent(gib(5.7)));
        assertTrue(DeviceRamTierPolicy.allowsLocalAgent(gib(7.2)));
        assertTrue(DeviceRamTierPolicy.allowsLocalAgent(gib(11.3)));
        assertTrue(DeviceRamTierPolicy.allowsLocalAgent(gib(15.2)));
    }

    @Test
    public void hybridAgentFloorIsFourMarketedGb() {
        assertFalse(DeviceRamTierPolicy.allowsHybridAgent(gib(2.8)));
        assertTrue(DeviceRamTierPolicy.allowsHybridAgent(kb(3_747_844)));
        assertTrue(DeviceRamTierPolicy.allowsHybridAgent(gib(5.7)));
    }

    @Test
    public void unreadableTotalMemFailsOpenForAnExplicitLocalChoice() {
        // The only mode that consults this gate is an explicit user "local"
        // choice; a probe failure must not brick it.
        assertTrue(DeviceRamTierPolicy.allowsLocalAgent(0L));
        assertTrue(DeviceRamTierPolicy.allowsLocalAgent(-1L));
        assertTrue(DeviceRamTierPolicy.allowsHybridAgent(0L));
        assertTrue(DeviceRamTierPolicy.allowsHybridAgent(-1L));
    }
}
