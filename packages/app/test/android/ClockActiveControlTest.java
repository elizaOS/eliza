package ai.elizaos.app;

import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Real journal effects and replay boundaries; no Android scheduling or phone acceptance. */
public final class ClockActiveControlTest {
    private static int checks;
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value) { if (!value) throw new AssertionError(); checks++; }
    private static void reject(Checked action) throws Exception {
        try { action.run(); } catch (SecurityException expected) { checks++; return; }
        throw new AssertionError("Rejected policy accepted");
    }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("clock-active-control-").toRealPath();
        String alarm = "12345678-1234-1234-1234-123456789abc";
        ClockHandoff.Request stop = ClockHandoff.Request.owned(ClockHandoff.Request.dismiss(), alarm, false);
        ClockHandoff.Request snooze = ClockHandoff.Request.owned(ClockHandoff.Request.snooze(5), alarm, false);
        var authority = new AtomicReference<ClockConsentCoordinator.ApprovedEntry>();
        var effects = new AtomicInteger();
        var coordinator = new ClockConsentCoordinator(root.resolve("journal"), "owner", id -> {
            var admitted = authority.get(); if (admitted == null) throw new SecurityException(); return admitted;
        }, directory -> { try (var channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); } }, () -> 1000L);
        ClockConsentCoordinator.Dispatcher dispatch = new ClockConsentCoordinator.Dispatcher() {
            public ClockHandoff.Outcome dispatch(ClockHandoff.Request request, ClockHandoff.ApprovedConsent consume) {
                consume.consume(request); effects.incrementAndGet(); return ClockHandoff.Outcome.APPLIED;
            }
            public String receipt() { return "{\"kind\":\"clock-alarm\",\"action\":\"dismiss\",\"status\":\"dismissed\",\"alarmId\":\"" + alarm + "\",\"nextAt\":null}"; }
        };
        var id = new ClockConsentCoordinator.Identity("a".repeat(64), "stop", "stop");
        authority.set(new ClockConsentCoordinator.ApprovedEntry(id, stop, "owner", "b".repeat(64)));
        check(coordinator.controlActiveAlarm(id, stop, dispatch) == ClockConsentCoordinator.Result.APPLIED);
        check(effects.get() == 1);
        check(coordinator.effectReceipt(id).contains("dismissed"));
        check(coordinator.controlActiveAlarm(id, stop, dispatch) == ClockConsentCoordinator.Result.APPLIED);
        check(effects.get() == 1);
        reject(() -> coordinator.controlActiveAlarm(id, snooze, dispatch));
        reject(() -> coordinator.controlActiveAlarm(id, ClockHandoff.Request.dismiss(), dispatch));
        reject(() -> coordinator.controlActiveAlarm(id, ClockHandoff.Request.delete(alarm), dispatch));
        authority.set(null); reject(() -> coordinator.controlActiveAlarm(id, stop, dispatch));
        var pending = new ClockConsentCoordinator.Identity("a".repeat(64), "pending", "pending");
        authority.set(new ClockConsentCoordinator.ApprovedEntry(pending, stop, "owner", "b".repeat(64)));
        coordinator.reviewClock(pending, stop);
        reject(() -> coordinator.controlActiveAlarm(pending, stop, dispatch));
        coordinator.cancelClock(pending);
        check(coordinator.controlActiveAlarm(pending, stop, dispatch) == ClockConsentCoordinator.Result.DENIED);
        check(effects.get() == 1);
        var lost = new ClockConsentCoordinator.Identity("a".repeat(64), "lost", "lost");
        authority.set(new ClockConsentCoordinator.ApprovedEntry(lost, stop, "owner", "b".repeat(64)));
        check(coordinator.controlActiveAlarm(lost, stop, (request, consume) -> { consume.consume(request); throw new IllegalStateException("Lost receipt"); }) == ClockConsentCoordinator.Result.UNKNOWN);
        check(coordinator.controlActiveAlarm(lost, stop, dispatch) == ClockConsentCoordinator.Result.UNKNOWN);
        check(effects.get() == 1);
        var snoozed = new ClockConsentCoordinator.Identity("a".repeat(64), "snooze", "snooze");
        authority.set(new ClockConsentCoordinator.ApprovedEntry(snoozed, snooze, "owner", "b".repeat(64)));
        ClockConsentCoordinator.Dispatcher snoozeEffect = new ClockConsentCoordinator.Dispatcher() {
            public ClockHandoff.Outcome dispatch(ClockHandoff.Request request, ClockHandoff.ApprovedConsent consume) {
                consume.consume(request); effects.incrementAndGet(); return ClockHandoff.Outcome.APPLIED;
            }
            public String receipt() { return "{\"kind\":\"clock-alarm\",\"action\":\"snooze\",\"status\":\"snoozed\",\"alarmId\":\"" + alarm + "\",\"nextAt\":1791352799003}"; }
        };
        check(coordinator.controlActiveAlarm(snoozed, snooze, snoozeEffect) == ClockConsentCoordinator.Result.APPLIED);
        check(coordinator.effectReceipt(snoozed).contains("snoozed"));
        check(coordinator.controlActiveAlarm(snoozed, snooze, snoozeEffect) == ClockConsentCoordinator.Result.APPLIED);
        check(effects.get() == 2);
        authority.set(new ClockConsentCoordinator.ApprovedEntry(snoozed, snooze, "wrong-owner", "b".repeat(64)));
        reject(() -> coordinator.controlActiveAlarm(snoozed, snooze, snoozeEffect));
        System.out.println("Active ringing journal policy passed: " + checks + " checks; no Android effects");
    }
}
