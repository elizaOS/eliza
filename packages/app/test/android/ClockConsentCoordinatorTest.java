/**
 * Exercises production consent persistence with real files, OS locks and process death.
 * The approved-entry lookup and dispatch counter are controlled contract fixtures;
 * this harness never launches Android Clock, sets an alarm, or claims device acceptance.
 */
package ai.elizaos.app;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

public final class ClockConsentCoordinatorTest {
    private interface Checked { void run() throws Exception; }
    private static int checks;
    private static final String SCOPE = "a".repeat(64), DIGEST = "b".repeat(64);
    private static ClockConsentCoordinator.Identity identity(String proposal) {
        return new ClockConsentCoordinator.Identity(SCOPE, proposal, "operation");
    }
    private static ClockConsentCoordinator.ApprovedEntry approved(ClockConsentCoordinator.Identity identity,
                                                                ClockHandoff.Request request, String owner) {
        return new ClockConsentCoordinator.ApprovedEntry(identity, request, owner, DIGEST);
    }
    private static void sync(Path directory) throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); }
    }
    private static ClockConsentCoordinator coordinator(Path directory, String owner,
                                                       AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority,
                                                       AtomicLong clock) throws IOException {
        return new ClockConsentCoordinator(directory, owner, id -> {
            ClockConsentCoordinator.ApprovedEntry entry = authority.get();
            if (entry == null) throw new SecurityException("Controlled server claim denied");
            return entry;
        }, ClockConsentCoordinatorTest::sync, clock::get);
    }
    private static String consent(ClockConsentCoordinator coordinator, ClockConsentCoordinator.Identity identity,
                                  ClockHandoff.Request request) throws IOException {
        check(coordinator.reviewClock(identity, request).result == null, "Native review should be required");
        return coordinator.approveFromNativeGesture(identity, request);
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }
    private static void rejects(Checked action) throws Exception {
        try { action.run(); }
        catch (SecurityException | IOException | IllegalArgumentException expected) { checks++; return; }
        throw new AssertionError("Untrusted Clock transition admitted");
    }
    private static ClockConsentCoordinator.Dispatcher dispatch(AtomicInteger effects) {
        return (request, consumed) -> { consumed.consume(request); effects.incrementAndGet(); return ClockHandoff.Outcome.OPENED; };
    }
    private static Path journal(Path root, String name) { return root.resolve(name); }

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("crash")) {
            Path directory = Path.of(args[1]);
            ClockConsentCoordinator.Identity id = identity("crash");
            AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority = new AtomicReference<>(approved(id, ClockHandoff.Request.show(), "owner"));
            ClockConsentCoordinator coordinator = coordinator(directory, "owner", authority, new AtomicLong(1000));
            coordinator.confirmClock(id, args[2], (request, consume) -> {
                consume.consume(request);
                Runtime.getRuntime().halt(19);
                throw new AssertionError("halt returned");
            });
            throw new AssertionError("Crash dispatch returned");
        }
        Path root = Files.createTempDirectory("eliza-clock-consent-contract-").toRealPath();
        try {
            AtomicLong clock = new AtomicLong(1000);
            ClockHandoff.Request request = ClockHandoff.Request.set(7, 30, "Wake up", "America/Los_Angeles");
            ClockConsentCoordinator.Identity id = identity("one");
            ClockConsentCoordinator.Identity firstId = id;
            ClockHandoff.Request firstRequest = request;
            AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority = new AtomicReference<>(approved(id, request, "owner"));
            Path one = journal(root, "one");
            ClockConsentCoordinator first = coordinator(one, "owner", authority, clock);
            rejects(() -> first.confirmClock(firstId, "c".repeat(64), dispatch(new AtomicInteger())));
            String token = consent(first, id, request);
            check(token.matches("[a-f0-9]{64}"), "Native token must be bounded random bytes");
            ClockConsentCoordinator restarted = coordinator(one, "owner", authority, clock);
            AtomicInteger effects = new AtomicInteger();
            check(restarted.confirmClock(id, token, dispatch(effects)) == ClockConsentCoordinator.Result.OPENED, "Saved consent should survive process restart");
            check(first.confirmClock(id, token, dispatch(effects)) == ClockConsentCoordinator.Result.OPENED, "Reply retry should return stored receipt");
            check(effects.get() == 1, "Intent must dispatch at most once");
            check(restarted.reviewClock(id, request).result == ClockConsentCoordinator.Result.OPENED, "Review retry should reconcile receipt");
            rejects(() -> restarted.confirmClock(firstId, "d".repeat(64), dispatch(effects)));
            rejects(() -> coordinator(one, "intruder", authority, clock).reviewClock(firstId, firstRequest));
            rejects(() -> coordinator(one, "intruder", authority, clock).cancelClock(firstId));
            rejects(() -> restarted.reviewClock(firstId, ClockHandoff.Request.set(7, 31, "Wake up", "America/Los_Angeles")));
            rejects(() -> restarted.reviewClock(firstId, ClockHandoff.Request.set(7, 30, "Different", "America/Los_Angeles")));
            rejects(() -> restarted.reviewClock(firstId, ClockHandoff.Request.set(7, 30, "Wake up", "UTC")));
            rejects(() -> restarted.reviewClock(new ClockConsentCoordinator.Identity(SCOPE, "one", "changed-attempt"), firstRequest));
            authority.set(null);
            rejects(() -> restarted.confirmClock(firstId, token, dispatch(effects)));
            authority.set(new ClockConsentCoordinator.ApprovedEntry(id, request, "owner", "c".repeat(64)));
            rejects(() -> restarted.reviewClock(firstId, firstRequest));

            id = identity("cancel"); request = ClockHandoff.Request.dismiss();
            authority.set(approved(id, request, "owner"));
            ClockConsentCoordinator cancelled = coordinator(journal(root, "cancel"), "owner", authority, clock);
            String cancelledToken = consent(cancelled, id, request);
            cancelled.cancelClock(id);
            check(cancelled.reviewClock(id, request).result == ClockConsentCoordinator.Result.DENIED, "Cancelled review must remain denied");
            ClockConsentCoordinator.Identity cancelledId = id;
            ClockHandoff.Request cancelledRequest = request;
            rejects(() -> cancelled.approveFromNativeGesture(cancelledId, cancelledRequest));
            check(cancelled.confirmClock(id, cancelledToken, dispatch(effects)) == ClockConsentCoordinator.Result.DENIED, "Cancelled token cannot dispatch");

            id = identity("expired"); request = ClockHandoff.Request.snooze(10);
            authority.set(approved(id, request, "owner"));
            ClockConsentCoordinator expired = coordinator(journal(root, "expired"), "owner", authority, clock);
            String expiredToken = consent(expired, id, request);
            ClockConsentCoordinator.Identity expiredId = id;
            clock.set(121000);
            rejects(() -> expired.confirmClock(expiredId, expiredToken, dispatch(effects)));
            clock.set(999);
            rejects(() -> expired.confirmClock(expiredId, expiredToken, dispatch(effects)));
            clock.set(1000);

            id = identity("unknown"); request = ClockHandoff.Request.show();
            authority.set(approved(id, request, "owner"));
            ClockConsentCoordinator unknown = coordinator(journal(root, "unknown"), "owner", authority, clock);
            String unknownToken = consent(unknown, id, request);
            check(unknown.confirmClock(id, unknownToken, (operation, consume) -> {
                consume.consume(operation); throw new IllegalStateException("Controlled launch exception");
            }) == ClockConsentCoordinator.Result.UNKNOWN, "Launch exception must record unknown");
            check(coordinator(journal(root, "unknown"), "owner", authority, clock).confirmClock(id, unknownToken, dispatch(effects))
                    == ClockConsentCoordinator.Result.UNKNOWN, "Unknown must never replay after restart");

            id = identity("unavailable"); authority.set(approved(id, request, "owner"));
            ClockConsentCoordinator unavailable = coordinator(journal(root, "unavailable"), "owner", authority, clock);
            String unavailableToken = consent(unavailable, id, request);
            check(unavailable.confirmClock(id, unavailableToken, (operation, consume) -> ClockHandoff.Outcome.UNAVAILABLE)
                    == ClockConsentCoordinator.Result.UNAVAILABLE, "No resolver result must remain unavailable");
            check(unavailable.confirmClock(id, unavailableToken, dispatch(effects)) == ClockConsentCoordinator.Result.UNAVAILABLE,
                    "Resolver absence must not silently retry after receipt");

            id = identity("consumed-unavailable"); authority.set(approved(id, request, "owner"));
            Path inconsistentDirectory = journal(root, "consumed-unavailable");
            ClockConsentCoordinator inconsistent = coordinator(inconsistentDirectory, "owner", authority, clock);
            String inconsistentToken = consent(inconsistent, id, request);
            check(inconsistent.confirmClock(id, inconsistentToken, (operation, consume) -> {
                consume.consume(operation); return ClockHandoff.Outcome.UNAVAILABLE;
            }) == ClockConsentCoordinator.Result.UNKNOWN, "Consumed dispatch cannot fabricate a not-applied result");
            check(coordinator(inconsistentDirectory, "owner", authority, clock).confirmClock(id, inconsistentToken, dispatch(effects))
                    == ClockConsentCoordinator.Result.UNKNOWN, "Inconsistent dispatcher receipt must remain unknown after restart");

            id = identity("rotated"); authority.set(approved(id, request, "owner"));
            ClockConsentCoordinator rotated = coordinator(journal(root, "rotated"), "owner", authority, clock);
            String oldToken = consent(rotated, id, request);
            String rotatedToken = rotated.approveFromNativeGesture(id, request);
            ClockConsentCoordinator.Identity rotatedId = id;
            rejects(() -> rotated.confirmClock(rotatedId, oldToken, dispatch(effects)));
            check(!oldToken.equals(rotatedToken), "A fresh native gesture must replace the previous token");
            rotated.cancelClock(id);

            id = identity("revoked-during-dispatch"); authority.set(approved(id, request, "owner"));
            ClockConsentCoordinator revoked = coordinator(journal(root, "revoked"), "owner", authority, clock);
            String revokedToken = consent(revoked, id, request);
            ClockConsentCoordinator.Identity revokedId = id;
            rejects(() -> revoked.confirmClock(revokedId, revokedToken, (operation, consume) -> {
                authority.set(null); consume.consume(operation); effects.incrementAndGet(); return ClockHandoff.Outcome.OPENED;
            }));
            authority.set(approved(id, request, "owner"));
            revoked.cancelClock(id);

            id = identity("durability"); authority.set(approved(id, request, "owner"));
            AtomicBoolean failSync = new AtomicBoolean();
            Path durabilityDirectory = journal(root, "durability");
            ClockConsentCoordinator durability = new ClockConsentCoordinator(durabilityDirectory, "owner", ignored -> authority.get(), directory -> {
                sync(directory);
                if (failSync.get()) throw new IOException("Controlled directory sync failure");
            }, clock::get);
            String durableToken = consent(durability, id, request);
            failSync.set(true);
            ClockConsentCoordinator.Identity durabilityId = id;
            rejects(() -> durability.confirmClock(durabilityId, durableToken, dispatch(effects)));
            failSync.set(false);
            check(coordinator(durabilityDirectory, "owner", authority, clock).confirmClock(id, durableToken, dispatch(effects))
                    == ClockConsentCoordinator.Result.UNKNOWN, "Failed dispatch fsync must never permit an intent replay");

            id = identity("unconsumed"); authority.set(approved(id, request, "owner"));
            ClockConsentCoordinator unconsumed = coordinator(journal(root, "unconsumed"), "owner", authority, clock);
            String unconsumedToken = consent(unconsumed, id, request);
            try {
                unconsumed.confirmClock(id, unconsumedToken, (operation, consume) -> ClockHandoff.Outcome.OPENED);
                throw new AssertionError("Dispatcher without consume fabricated an opened receipt");
            } catch (IllegalStateException expected) { checks++; }
            unconsumed.cancelClock(id);

            id = identity("parallel"); authority.set(approved(id, request, "owner"));
            Path parallelDirectory = journal(root, "parallel");
            ClockConsentCoordinator parallel = coordinator(parallelDirectory, "owner", authority, clock);
            String parallelToken = consent(parallel, id, request);
            ClockConsentCoordinator.Identity parallelId = id;
            AtomicInteger parallelEffects = new AtomicInteger();
            try (var workers = Executors.newFixedThreadPool(8)) {
                List<Callable<ClockConsentCoordinator.Result>> calls = new ArrayList<>();
                for (int i = 0; i < 24; i++) calls.add(() -> coordinator(parallelDirectory, "owner", authority, clock)
                        .confirmClock(parallelId, parallelToken, dispatch(parallelEffects)));
                for (Future<ClockConsentCoordinator.Result> result : workers.invokeAll(calls))
                    check(result.get() == ClockConsentCoordinator.Result.OPENED, "Concurrent confirm must reconcile same receipt");
            }
            check(parallelEffects.get() == 1, "Concurrent confirms must cause one controlled effect");

            id = identity("crash"); authority.set(approved(id, request, "owner"));
            Path crashDirectory = journal(root, "crash");
            ClockConsentCoordinator crash = coordinator(crashDirectory, "owner", authority, clock);
            String crashToken = consent(crash, id, request);
            Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-cp", System.getProperty("java.class.path"), ClockConsentCoordinatorTest.class.getName(),
                    "crash", crashDirectory.toString(), crashToken).inheritIO().start();
            check(child.waitFor() == 19, "Child must die after durable consume and before receipt");
            ClockConsentCoordinator afterCrash = coordinator(crashDirectory, "owner", authority, clock);
            check(afterCrash.reviewClock(id, request).result == ClockConsentCoordinator.Result.UNKNOWN, "Interrupted dispatch must be unknown");
            check(afterCrash.confirmClock(id, crashToken, dispatch(effects)) == ClockConsentCoordinator.Result.UNKNOWN,
                    "Process death must never replay intent");

            Path persisted;
            try (var files = Files.list(crashDirectory)) {
                persisted = files.filter(path -> !path.getFileName().toString().equals("lock")).findFirst().orElseThrow();
            }
            byte[] bytes = Files.readAllBytes(persisted); bytes[8] ^= 1; Files.write(persisted, bytes);
            ClockConsentCoordinator.Identity crashId = id;
            ClockHandoff.Request crashRequest = request;
            rejects(() -> afterCrash.reviewClock(crashId, crashRequest));
            check(effects.get() == 1, "Rejected and replayed contracts must add no effects");
            System.out.println("Clock consent contract passed: " + checks + " checks; Android dispatch/device acceptance untested");
        } finally {
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }
}
