/**
 * Exercises production consent persistence with real files, OS locks and process death.
 * The approved-entry lookup and dispatch counter are controlled contract fixtures;
 * this harness never launches Android Clock, sets an alarm, or claims device acceptance.
 */
package ai.elizaos.app;

import java.io.IOException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Arrays;
import java.util.HexFormat;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

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
    private static Path stored(Path directory) throws IOException {
        try (var files = Files.list(directory)) {
            return files.filter(path -> path.getFileName().toString().matches("[a-f0-9]{64}")).findFirst().orElseThrow();
        }
    }
    /** Independent old-format fixture: no recurrence field existed in CLK1. */
    private static Path legacy(Path directory, ClockConsentCoordinator.Identity id,
                               ClockHandoff.Request request, String phase, String result, String token) throws Exception {
        ByteArrayOutputStream payload = new ByteArrayOutputStream();
        try (DataOutputStream output = new DataOutputStream(payload)) {
            output.writeInt(0x434c4b31);
            output.writeUTF(id.scope); output.writeUTF(id.proposalId); output.writeUTF(id.operationId);
            output.writeUTF("owner"); output.writeUTF(DIGEST); output.writeUTF("SET");
            output.writeInt(request.hour); output.writeInt(request.minute); output.writeUTF(request.label); output.writeUTF(request.timeZone);
            output.writeUTF(phase);
            output.writeUTF(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8))));
            output.writeLong(1000); output.writeLong(121000); output.writeUTF(result);
        }
        Path file = directory.resolve(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest((id.scope + ":" + id.proposalId).getBytes(StandardCharsets.UTF_8))));
        savePayload(file, payload.toByteArray());
        return file;
    }
    private static void savePayload(Path file, byte[] payload) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write(payload); bytes.write(MessageDigest.getInstance("SHA-256").digest(payload));
        Files.write(file, bytes.toByteArray());
    }
    private static void repeatContracts(Path root) throws Exception {
        AtomicLong clock = new AtomicLong(1000);
        AtomicInteger effects = new AtomicInteger();
        for (List<Integer> days : List.of(List.<Integer>of(), List.of(1, 2, 3, 4, 5, 6, 7),
                List.of(2, 3, 4, 5, 6), List.of(7, 1, 3))) {
            ClockConsentCoordinator.Identity id = identity("repeat-" + effects.get());
            ClockHandoff.Request request = ClockHandoff.Request.set(9, 0, "Wake up", "UTC", days);
            AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority = new AtomicReference<>(approved(id, request, "owner"));
            Path directory = journal(root, id.proposalId);
            ClockConsentCoordinator coordinator = coordinator(directory, "owner", authority, clock);
            String token = consent(coordinator, id, request);
            ClockConsentCoordinator restarted = coordinator(directory, "owner", authority, clock);
            check(restarted.reviewClock(id, request).request.days.equals(days), "Exact repeat must survive restart");
            ClockHandoff.Request omitted = ClockHandoff.Request.set(9, 0, "Wake up", "UTC");
            rejects(() -> restarted.reviewClock(id, omitted));
            ClockHandoff.Request changed = ClockHandoff.Request.set(9, 0, "Wake up", "UTC", days.equals(List.of(2)) ? List.of(3) : List.of(2));
            authority.set(approved(id, changed, "owner"));
            rejects(() -> restarted.confirmClock(id, token, dispatch(effects)));
            authority.set(approved(id, request, "owner"));
            rejects(() -> restarted.confirmClock(id, token, (operation, consume) -> {
                consume.consume(changed); effects.incrementAndGet(); return ClockHandoff.Outcome.OPENED;
            }));
            int before = effects.get();
            check(restarted.confirmClock(id, token, (operation, consume) -> {
                check(operation.days.equals(days), "Dispatcher must receive exactly reviewed repeat");
                consume.consume(operation); effects.incrementAndGet(); return ClockHandoff.Outcome.OPENED;
            }) == ClockConsentCoordinator.Result.OPENED, "Repeat should dispatch once");
            check(coordinator(directory, "owner", authority, clock).confirmClock(id, token, dispatch(effects))
                    == ClockConsentCoordinator.Result.OPENED && effects.get() == before + 1, "Repeat receipt must prevent replay");
        }
        ClockConsentCoordinator.Identity id = identity("repeat-tamper");
        ClockHandoff.Request request = ClockHandoff.Request.set(9, 0, "Wake up", "UTC", List.of(2, 3, 4, 5, 6));
        AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority = new AtomicReference<>(approved(id, request, "owner"));
        Path directory = journal(root, id.proposalId);
        ClockConsentCoordinator coordinator = coordinator(directory, "owner", authority, clock);
        String token = consent(coordinator, id, request);
        Path file = stored(directory);
        byte[] original = Files.readAllBytes(file);
        byte[] payload = Arrays.copyOf(original, original.length - 32);
        int dayOffset;
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(payload))) {
            check(input.readInt() == 0x434c4b32, "New recurrence entries must use CLK2");
            for (int field = 0; field < 6; field++) input.readUTF();
            input.readInt(); input.readInt(); input.readUTF(); input.readUTF();
            check(input.readInt() == 5, "Journal must retain explicit repeat count");
            dayOffset = payload.length - input.available();
        }
        java.nio.ByteBuffer.wrap(payload).putInt(dayOffset, 1);
        savePayload(file, payload);
        rejects(() -> coordinator(directory, "owner", authority, clock).confirmClock(id, token, dispatch(effects)));
        java.nio.ByteBuffer.wrap(payload).putInt(dayOffset, 0);
        savePayload(file, payload);
        rejects(() -> coordinator(directory, "owner", authority, clock).reviewClock(id, request));
        java.nio.ByteBuffer.wrap(payload).putInt(dayOffset, 3);
        savePayload(file, payload);
        rejects(() -> coordinator(directory, "owner", authority, clock).reviewClock(id, request));
        java.nio.ByteBuffer.wrap(payload).putInt(dayOffset - 4, 8);
        savePayload(file, payload);
        rejects(() -> coordinator(directory, "owner", authority, clock).reviewClock(id, request));
        Files.write(file, original);
        check(coordinator(directory, "owner", authority, clock).confirmClock(id, token, dispatch(effects))
                == ClockConsentCoordinator.Result.OPENED && effects.get() == 5, "Tampered repeat must cause no effect");

        for (String phase : List.of("DISPATCHED", "COMPLETE", "CANCELLED")) {
            ClockConsentCoordinator.Identity oldId = identity("legacy-" + phase);
            ClockHandoff.Request oldRequest = ClockHandoff.Request.set(9, 0, "Old", "UTC");
            AtomicReference<ClockConsentCoordinator.ApprovedEntry> oldAuthority = new AtomicReference<>(approved(oldId, oldRequest, "owner"));
            Path oldDirectory = journal(root, oldId.proposalId);
            ClockConsentCoordinator old = coordinator(oldDirectory, "owner", oldAuthority, clock);
            String oldToken = "c".repeat(64);
            Path oldFile = legacy(oldDirectory, oldId, oldRequest, phase, phase.equals("COMPLETE") ? "OPENED" : "", oldToken);
            byte[] oldBytes = Files.readAllBytes(oldFile);
            ClockConsentCoordinator.Result expected = phase.equals("DISPATCHED") ? ClockConsentCoordinator.Result.UNKNOWN
                    : phase.equals("COMPLETE") ? ClockConsentCoordinator.Result.OPENED : ClockConsentCoordinator.Result.DENIED;
            check(old.reviewClock(oldId, oldRequest).result == expected, "Legacy receipt must reconcile unchanged");
            check(coordinator(oldDirectory, "owner", oldAuthority, clock).confirmClock(oldId, oldToken, dispatch(effects))
                    == expected && effects.get() == 5, "Legacy consumed/cancelled receipt must never replay");
            old.cancelClock(oldId);
            check(Arrays.equals(oldBytes, Files.readAllBytes(oldFile)), "Legacy consumed receipt bytes must stay untouched");
            ClockHandoff.Request explicit = ClockHandoff.Request.set(9, 0, "Old", "UTC", List.of());
            oldAuthority.set(approved(oldId, explicit, "owner"));
            rejects(() -> old.reviewClock(oldId, explicit));
            check(Arrays.equals(oldBytes, Files.readAllBytes(oldFile)), "Changed repeat cannot overwrite old receipt");
        }
        ClockConsentCoordinator.Identity pendingId = identity("legacy-consent");
        ClockHandoff.Request pendingRequest = ClockHandoff.Request.set(9, 0, "Old", "UTC");
        AtomicReference<ClockConsentCoordinator.ApprovedEntry> pendingAuthority = new AtomicReference<>(approved(pendingId, pendingRequest, "owner"));
        Path pendingDirectory = journal(root, pendingId.proposalId);
        ClockConsentCoordinator pending = coordinator(pendingDirectory, "owner", pendingAuthority, clock);
        String oldToken = "d".repeat(64);
        Path pendingFile = legacy(pendingDirectory, pendingId, pendingRequest, "CONSENT", "", oldToken);
        check(pending.confirmClock(pendingId, oldToken, dispatch(effects)) == ClockConsentCoordinator.Result.OPENED,
                "Previously approved legacy consent should retain its one-off contract");
        try (DataInputStream input = new DataInputStream(Files.newInputStream(pendingFile))) {
            check(input.readInt() == 0x434c4b31, "Legacy pending transitions must retain CLK1 encoding");
        }
        check(coordinator(pendingDirectory, "owner", pendingAuthority, clock).confirmClock(pendingId, oldToken, dispatch(effects))
                == ClockConsentCoordinator.Result.OPENED && effects.get() == 6, "Legacy transition receipt must never replay");

        ClockConsentCoordinator.Identity crashId = identity("repeat-crash");
        ClockHandoff.Request crashRequest = ClockHandoff.Request.set(9, 0, "Daily", "UTC", List.of(1, 2, 3, 4, 5, 6, 7));
        AtomicReference<ClockConsentCoordinator.ApprovedEntry> crashAuthority = new AtomicReference<>(approved(crashId, crashRequest, "owner"));
        Path crashDirectory = journal(root, crashId.proposalId);
        ClockConsentCoordinator crash = coordinator(crashDirectory, "owner", crashAuthority, clock);
        String crashToken = consent(crash, crashId, crashRequest);
        Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("java.class.path"), ClockConsentCoordinatorTest.class.getName(),
                "crash-repeat", crashDirectory.toString(), crashToken).inheritIO().start();
        check(child.waitFor() == 19, "Recurring child must die after durable consume");
        ClockConsentCoordinator afterCrash = coordinator(crashDirectory, "owner", crashAuthority, clock);
        check(afterCrash.reviewClock(crashId, crashRequest).result == ClockConsentCoordinator.Result.UNKNOWN,
                "Recurring process death must reconcile unknown");
        check(afterCrash.confirmClock(crashId, crashToken, dispatch(effects)) == ClockConsentCoordinator.Result.UNKNOWN
                && effects.get() == 6, "Recurring process death must never replay");
    }

    private static ClockHandoff.Request ownedSet() {
        return ClockHandoff.Request.owned(ClockHandoff.Request.set(9, 0, "Owned weekdays", "UTC", List.of(2, 3, 4, 5, 6)), null, false);
    }
    private static ClockConsentCoordinator.Identity ownedCrashIdentity() {
        String id = "12345678-1234-1234-1234-123456789abc";
        return new ClockConsentCoordinator.Identity(SCOPE, id, id);
    }
    /** The production V3 file codec and receipt latch are real; no Android schedule is simulated. */
    private static void ownedContracts(Path root) throws Exception {
        AtomicLong clock = new AtomicLong(1000);
        AtomicInteger effects = new AtomicInteger();
        String target = "87654321-1234-1234-1234-123456789abc";
        List<ClockHandoff.Request> operations = List.of(ownedSet(),
                ClockHandoff.Request.update(10, 15, "Keep disabled", "UTC", List.of(), target),
                ClockHandoff.Request.delete(target), ClockHandoff.Request.enable(target, true),
                ClockHandoff.Request.enable(target, false), ClockHandoff.Request.owned(ClockHandoff.Request.dismiss(), target, false),
                ClockHandoff.Request.owned(ClockHandoff.Request.snooze(10), target, false),
                ClockHandoff.Request.owned(ClockHandoff.Request.show(), null, false));
        for (ClockHandoff.Request request : operations) {
            String id = java.util.UUID.randomUUID().toString();
            ClockConsentCoordinator.Identity identity = new ClockConsentCoordinator.Identity(SCOPE, id, id);
            AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority = new AtomicReference<>(approved(identity, request, "owner"));
            Path directory = journal(root, "owned-" + id);
            ClockConsentCoordinator first = coordinator(directory, "owner", authority, clock);
            String token = consent(first, identity, request);
            JSONObject receipt = new JSONObject().put("kind", "clock-alarm").put("action", request.action.name().toLowerCase(java.util.Locale.ROOT));
            String status = request.action == ClockHandoff.Action.SET ? "scheduled" : request.action == ClockHandoff.Action.UPDATE ? "updated"
                    : request.action == ClockHandoff.Action.DELETE ? "deleted" : request.action == ClockHandoff.Action.ENABLE ? (request.enabled ? "enabled" : "disabled")
                    : request.action == ClockHandoff.Action.DISMISS ? "dismissed" : request.action == ClockHandoff.Action.SNOOZE ? "snoozed" : "shown";
            receipt.put("status", status);
            if (request.action != ClockHandoff.Action.SHOW) receipt.put("alarmId", request.action == ClockHandoff.Action.SET ? id : target);
            if (request.action != ClockHandoff.Action.SHOW && request.action != ClockHandoff.Action.DELETE)
                receipt.put("nextAt", request.action == ClockHandoff.Action.UPDATE || (request.action == ClockHandoff.Action.ENABLE && !request.enabled)
                        ? JSONObject.NULL : 1791378000000L);
            String exactReceipt = receipt.toString();
            int before = effects.get();
            check(first.confirmClock(identity, token, new ClockConsentCoordinator.Dispatcher() {
                @Override public ClockHandoff.Outcome dispatch(ClockHandoff.Request selected, ClockHandoff.ApprovedConsent consume) {
                    consume.consume(selected); effects.incrementAndGet(); return ClockHandoff.Outcome.APPLIED;
                }
                @Override public String receipt() { return exactReceipt; }
            }) == ClockConsentCoordinator.Result.APPLIED, "Owned receipt must settle after durable consume");
            byte[] bytes = Files.readAllBytes(stored(directory));
            try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
                check(input.readInt() == 0x434c4b33, "Owned claims must use the additive V3 journal format");
            }
            ClockConsentCoordinator restarted = coordinator(directory, "owner", authority, clock);
            check(restarted.reconcileClock(identity, request).result == ClockConsentCoordinator.Result.APPLIED, "V3 applied outcome must survive restart");
            check(exactReceipt.equals(restarted.effectReceipt(identity)), "V3 must preserve the exact typed receipt without reconstruction");
            check(ClockHostReceipts.result(request, ClockConsentCoordinator.Result.APPLIED, exactReceipt, id).toString().equals(exactReceipt),
                    "Restored V3 receipt must validate against the selected action and target");
            check(restarted.confirmClock(identity, token, dispatch(effects)) == ClockConsentCoordinator.Result.APPLIED && effects.get() == before + 1,
                    "V3 receipt recovery must never repeat an effect");
            check(Arrays.equals(bytes, Files.readAllBytes(stored(directory))), "V3 read/replay must not rewrite the immutable receipt");
            rejects(() -> coordinator(directory, "other-owner", authority, clock).effectReceipt(identity));
            authority.set(new ClockConsentCoordinator.ApprovedEntry(identity, request, "owner", "c".repeat(64)));
            rejects(() -> restarted.effectReceipt(identity));
        }
        ClockConsentCoordinator.Identity identity = ownedCrashIdentity();
        ClockHandoff.Request request = ownedSet();
        AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority = new AtomicReference<>(approved(identity, request, "owner"));
        Path missing = journal(root, "owned-missing-receipt");
        ClockConsentCoordinator first = coordinator(missing, "owner", authority, clock);
        String token = consent(first, identity, request);
        check(first.confirmClock(identity, token, (selected, consume) -> { consume.consume(selected); return ClockHandoff.Outcome.APPLIED; })
                == ClockConsentCoordinator.Result.UNKNOWN, "Consumed effect without typed evidence must remain unknown");
        ClockConsentCoordinator restarted = coordinator(missing, "owner", authority, clock);
        check(restarted.effectReceipt(identity) == null, "Unknown V3 must not invent an applied receipt");
        int before = effects.get();
        check(restarted.confirmClock(identity, token, dispatch(effects)) == ClockConsentCoordinator.Result.UNKNOWN && effects.get() == before,
                "Unknown V3 must never redispatch");
        Path crashDirectory = journal(root, "owned-crash");
        ClockConsentCoordinator crash = coordinator(crashDirectory, "owner", authority, clock);
        String crashToken = consent(crash, identity, request);
        Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("java.class.path"), ClockConsentCoordinatorTest.class.getName(),
                "crash-owned", crashDirectory.toString(), crashToken).inheritIO().start();
        check(child.waitFor() == 19, "V3 process must die after durable consume and before receipt");
        ClockConsentCoordinator afterCrash = coordinator(crashDirectory, "owner", authority, clock);
        check(afterCrash.reconcileClock(identity, request).result == ClockConsentCoordinator.Result.UNKNOWN,
                "V3 interrupted dispatch must survive restart as unknown");
        check(afterCrash.confirmClock(identity, crashToken, dispatch(effects)) == ClockConsentCoordinator.Result.UNKNOWN && effects.get() == before,
                "V3 process death must never replay an effect");
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && (args[0].equals("crash") || args[0].equals("crash-repeat") || args[0].equals("crash-owned"))) {
            Path directory = Path.of(args[1]);
            boolean repeat = args[0].equals("crash-repeat");
            boolean owned = args[0].equals("crash-owned");
            ClockConsentCoordinator.Identity id = owned ? ownedCrashIdentity() : identity(repeat ? "repeat-crash" : "crash");
            ClockHandoff.Request request = owned ? ownedSet() : repeat ? ClockHandoff.Request.set(9, 0, "Daily", "UTC", List.of(1, 2, 3, 4, 5, 6, 7))
                    : ClockHandoff.Request.show();
            AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority = new AtomicReference<>(approved(id, request, "owner"));
            ClockConsentCoordinator coordinator = coordinator(directory, "owner", authority, new AtomicLong(1000));
            coordinator.confirmClock(id, args[2], (operation, consume) -> {
                consume.consume(operation);
                Runtime.getRuntime().halt(19);
                throw new AssertionError("halt returned");
            });
            throw new AssertionError("Crash dispatch returned");
        }
        Path root = Files.createTempDirectory("eliza-clock-consent-contract-").toRealPath();
        try {
            repeatContracts(root);
            ownedContracts(root);
            AtomicLong clock = new AtomicLong(1000);
            ClockHandoff.Request request = ClockHandoff.Request.set(7, 30, "Wake up", "America/Los_Angeles");
            ClockConsentCoordinator.Identity id = identity("one");
            ClockConsentCoordinator.Identity firstId = id;
            ClockHandoff.Request firstRequest = request;
            AtomicReference<ClockConsentCoordinator.ApprovedEntry> authority = new AtomicReference<>(approved(id, request, "owner"));
            Path one = journal(root, "one");
            ClockConsentCoordinator first = coordinator(one, "owner", authority, clock);
            rejects(() -> first.reconcileClock(firstId, firstRequest));
            try (var files = Files.list(one)) {
                check(files.noneMatch(path -> path.getFileName().toString().matches("[a-f0-9]{64}")),
                        "Read-only reconciliation must not create native consent for a server claim");
            }
            rejects(() -> first.confirmClock(firstId, "c".repeat(64), dispatch(new AtomicInteger())));
            String token = consent(first, id, request);
            byte[] consentBytes = Files.readAllBytes(stored(one));
            check(first.reconcileClock(id, request).result == null && Arrays.equals(consentBytes, Files.readAllBytes(stored(one))),
                    "Pending reconciliation must not change or remint native consent");
            check(token.matches("[a-f0-9]{64}"), "Native token must be bounded random bytes");
            ClockConsentCoordinator restarted = coordinator(one, "owner", authority, clock);
            AtomicInteger effects = new AtomicInteger();
            check(restarted.confirmClock(id, token, dispatch(effects)) == ClockConsentCoordinator.Result.OPENED, "Saved consent should survive process restart");
            check(first.confirmClock(id, token, dispatch(effects)) == ClockConsentCoordinator.Result.OPENED, "Reply retry should return stored receipt");
            check(effects.get() == 1, "Intent must dispatch at most once");
            check(restarted.reviewClock(id, request).result == ClockConsentCoordinator.Result.OPENED, "Review retry should reconcile receipt");
            check(restarted.reconcileClock(id, request).result == ClockConsentCoordinator.Result.OPENED,
                    "Read-only reconciliation must return consumed receipt");
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
