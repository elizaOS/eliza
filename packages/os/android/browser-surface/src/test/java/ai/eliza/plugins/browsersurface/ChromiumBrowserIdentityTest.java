package ai.eliza.plugins.browsersurface;

import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class ChromiumBrowserIdentityTest {
    private static final String DIGEST = "ab".repeat(32);

    @Test public void allowsOnlyTheTwoBuildPackages() {
        assertTrue(ChromiumBrowserIdentity.isAllowedPackage("org.chromium.chrome"));
        assertTrue(ChromiumBrowserIdentity.isAllowedPackage("ai.elizaos.chromium"));
        for (String value : new String[] {null, "", " org.chromium.chrome", "com.android.chrome", "ai.elizaos.chromium.evil", "org.chromium.chrome;other"}) {
            assertFalse(ChromiumBrowserIdentity.isAllowedPackage(value));
        }
    }

    @Test public void checksTheSelectedPackageAndExactCertificateBytes() {
        for (String selected : new String[] {"org.chromium.chrome", "ai.elizaos.chromium"}) {
            AtomicInteger calls = new AtomicInteger();
            assertTrue(ChromiumBrowserIdentity.isTrustedPackage(selected, DIGEST.toUpperCase(), (name, digest) -> {
                calls.incrementAndGet();
                assertEquals(selected, name);
                assertEquals(32, digest.length);
                for (byte item : digest) assertEquals((byte) 0xab, item);
                return true;
            }));
            assertEquals(1, calls.get());
        }
    }

    @Test public void sameSignerOnOtherPackageDoesNotAuthorizeBinderCaller() {
        AtomicInteger calls = new AtomicInteger();
        ChromiumBrowserIdentity.SigningCertificateLookup match = (name, digest) -> { calls.incrementAndGet(); return true; };
        assertFalse(ChromiumBrowserIdentity.isTrustedCaller(new String[] {"org.chromium.chrome"}, "ai.elizaos.chromium", DIGEST, match));
        assertFalse(ChromiumBrowserIdentity.isTrustedCaller(new String[] {"ai.elizaos.chromium"}, "org.chromium.chrome", DIGEST, match));
        assertFalse(ChromiumBrowserIdentity.isTrustedCaller(null, "ai.elizaos.chromium", DIGEST, match));
        assertEquals(0, calls.get());
        assertTrue(ChromiumBrowserIdentity.isTrustedCaller(new String[] {"ai.elizaos.chromium"}, "ai.elizaos.chromium", DIGEST, match));
        assertEquals(1, calls.get());
    }

    @Test public void wrongSignerAndMalformedOrUnconfiguredPinsFailClosed() {
        assertFalse(ChromiumBrowserIdentity.isTrustedPackage("ai.elizaos.chromium", DIGEST, (name, digest) -> false));
        assertFalse(ChromiumBrowserIdentity.isTrustedCaller(new String[] {"ai.elizaos.chromium"}, "ai.elizaos.chromium", DIGEST, (name, digest) -> false));
        for (String digest : new String[] {null, "", "a".repeat(63), "g".repeat(64), DIGEST + "\n"}) {
            assertFalse(ChromiumBrowserIdentity.isTrustedPackage("ai.elizaos.chromium", digest, (name, bytes) -> {
                fail("Invalid configuration must never reach the package manager");
                return true;
            }));
        }
        assertFalse(ChromiumBrowserIdentity.isTrustedPackage("com.attacker.browser", DIGEST, (name, digest) -> true));
    }
}
