package ai.elizaos.app;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Production retirement policy with a real native journal and a fail-once directory sync. */
public final class ClockOwnerRetirementTest {
    private static int checks;
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
    public static void main(String[] args) throws Exception {
        Path parent = Files.createTempDirectory("eliza-clock-retire-").toRealPath();
        AtomicBoolean fail = new AtomicBoolean(); AtomicInteger syncs = new AtomicInteger(), effects = new AtomicInteger();
        ClockConsentCoordinator.Identity id = new ClockConsentCoordinator.Identity("a".repeat(64), "old", "old");
        ClockHandoff.Request request = ClockHandoff.Request.show();
        ClockOwnerRetirement retirement = new ClockOwnerRetirement();
        try {
            ClockConsentCoordinator coordinator = new ClockConsentCoordinator(parent.resolve("journal"), "old-owner",
                    identity -> new ClockConsentCoordinator.ApprovedEntry(id, request, "old-owner", "b".repeat(64)), directory -> {
                syncs.incrementAndGet();
                if (fail.get()) throw new IOException("Controlled cancellation sync failure");
                try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); }
            }, () -> 1000);
            coordinator.reviewClock(id, request); String token = coordinator.approveFromNativeGesture(id, request);
            fail.set(true);
            try { retirement.retry(() -> coordinator.cancelClock(id)); throw new AssertionError("Retirement fabricated success"); }
            catch (IOException expected) { checks++; }
            check(retirement.isBlocked(), "Failed whole-owner retirement must block new admission");
            int failedSyncs = syncs.get(); fail.set(false);
            retirement.retry(() -> coordinator.cancelClock(id));
            check(syncs.get() > failedSyncs, "Cancelled journal retry must actually retry directory durability");
            check(!retirement.isBlocked(), "Verified complete retirement must permit a new owner");
            check(coordinator.confirmClock(id, token, (operation, consume) -> {
                consume.consume(operation); effects.incrementAndGet(); return ClockHandoff.Outcome.OPENED;
            }) == ClockConsentCoordinator.Result.DENIED && effects.get() == 0, "Retired consent must never dispatch");
            ClockConsentCoordinator.Identity next = new ClockConsentCoordinator.Identity("c".repeat(64), "new", "new");
            ClockConsentCoordinator fresh = new ClockConsentCoordinator(parent.resolve("journal"), "new-owner",
                    identity -> new ClockConsentCoordinator.ApprovedEntry(next, request, "new-owner", "d".repeat(64)), directory -> {
                try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); }
            }, () -> 1000);
            check(!retirement.isBlocked() && fresh.reviewClock(next, request).result == null, "New owner must admit after verified retirement");
        } finally {
            try (var paths = Files.walk(parent)) { for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path); }
        }
        System.out.println("Native owner retirement passed: " + checks + " checks; real journal only, no Android dispatch");
    }
}
