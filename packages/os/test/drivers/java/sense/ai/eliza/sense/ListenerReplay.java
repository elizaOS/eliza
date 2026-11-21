// spec/os/voice/listener.md, "Story: Keep wake listening on the device under my control"; spec/os/voice/listener.md, "Story: Listen only while the indicator shows it"
package ai.eliza.sense;

import com.android.systemui.privacy.SenseListeningPolicy;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ListenerReplay {
    private static final String LISTENER_PACKAGE = "test.listener";
    private static final String ADMITTED_SIGNER = "a".repeat(64);
    private static final String OTHER_SIGNER = "b".repeat(64);

    private static final class Device {
        boolean recordAudio, notificationsVisible, userForeground, unlocked, keyguardLocked = true, speechUnavailable,
                inCall, otherAppRecording, micSilenced, speechPlaying, screenInteractive = true;
    }

    private boolean consented, storedEnabled, tripped, sessionOpen;
    private long pausedUntil, pauseBoot = -1, sessionBoot = -1, sessionInstall = -1;
    private long[] exits = new long[0];
    private long boot = 1, install = 1;

    private boolean processConsent, indicatorLost, microphoneHeld;
    private ListenerPolicy.IndicatorPause indicatorPause = ListenerPolicy.IndicatorPause.NONE;
    private long unsilencedSince = -1;
    private IndicatorLease lease = new IndicatorLease();
    private long linked = -1, held = -1;

    private int queued, delivered;
    private boolean running, foreground, stopConfirmed;
    private String promotion = "NoPromotion", lastWake = "NoWake";
    private Device device = new Device();
    private long now;
    private final List<String> out = new ArrayList<>();

    private static Matcher field(String body, String name, String value) {
        Matcher found = Pattern.compile("\"" + name + "\"\\s*:\\s*" + value).matcher(body);
        if (!found.find()) throw new IllegalArgumentException("an event without " + name + ": " + body);
        return found;
    }

    private static boolean flag(String body, String name) { return Boolean.parseBoolean(field(body, name, "(true|false)").group(1)); }
    private static long number(String body, String name) { return Long.parseLong(field(body, name, "(-?\\d+)").group(1)); }
    private static String text(String body, String name) { return field(body, name, "\"(\\w+)\"").group(1); }

    private static String sender(String line) {
        Matcher by = Pattern.compile("\"by\"\\s*:\\s*\"(\\w+)\"").matcher(line);
        return by.find() ? by.group(1) : "";
    }

    private boolean enabled() { return processConsent && storedEnabled; }

    private boolean requireAttribution() { return IndicatorLease.requiresAttribution(microphoneHeld && unsilencedSince >= 0, unsilencedSince, now); }

    private IndicatorLease.Loss observeLease() {
        IndicatorLease.Loss loss = lease.verdict(now, boot, requireAttribution(), device.screenInteractive);
        IndicatorLease.Observation seen = IndicatorLease.observe(microphoneHeld, indicatorPause, loss);
        if (seen.latches()) indicatorLost = true;
        indicatorPause = seen.pause();
        return loss;
    }

    private ListenerPolicy.State decide() {
        ListenerPolicy.Inputs in = new ListenerPolicy.Inputs();
        in.consentVersion = consented ? ListenerPolicy.CONSENT_VERSION : 0;
        in.enabled = enabled();
        in.recordAudioGranted = device.recordAudio;
        in.notificationsVisible = device.notificationsVisible;
        in.userForeground = device.userForeground;
        in.crashLoopTripped = tripped;
        in.userUnlocked = device.unlocked;
        in.speechUnavailable = device.speechUnavailable;
        in.pausedUntilMs = ListenerPolicy.effectivePause(pausedUntil, pauseBoot, boot);
        in.inCall = device.inCall;
        in.otherAppRecording = device.otherAppRecording;
        in.micSilenced = device.micSilenced;
        in.indicatorLeaseValid = observeLease() == IndicatorLease.Loss.NONE;
        in.indicatorLost = indicatorLost;
        in.indicatorPause = indicatorPause;
        return ListenerPolicy.decide(in, now);
    }

    private void pause(long until) {
        pausedUntil = until;
        pauseBoot = boot;
    }

    private void resume() {
        pausedUntil = 0;
        exits = new long[0];
        tripped = false;
        indicatorLost = false;
    }

    private void setEnabled(boolean on) {
        storedEnabled = on;
        pausedUntil = 0;
        if (on) {
            exits = new long[0];
            tripped = false;
            indicatorLost = false;
        }
    }

    private void startCapture() {
        if (microphoneHeld || !device.recordAudio) return;
        sessionOpen = true;
        sessionBoot = boot;
        sessionInstall = install;
        unsilencedSince = device.micSilenced ? -1 : now;
        microphoneHeld = true;
    }

    private void stopCapture() {
        if (microphoneHeld) sessionOpen = false;
        microphoneHeld = false;
        unsilencedSince = -1;
    }

    private void stopSelf() { running = delivered != queued; }

    private void apply(boolean owed, boolean refuses) {
        ListenerPolicy.State state = decide();
        if (!ListenerPolicy.foreground(state)) {
            stopCapture();
            promotion = owed ? refuses ? "PromotionRefused" : "Promoted" : "NoPromotion";
            if (owed && refuses) out.add("ForegroundRefused");
            foreground = false;
            stopSelf();
            return;
        }
        if (refuses) {
            promotion = "PromotionRefused";
            out.add("ForegroundRefused");
            foreground = false;
            stopCapture();
            stopSelf();
            return;
        }
        promotion = "Promoted";
        foreground = true;
        if (ListenerPolicy.holdsMicrophone(state)) startCapture();
        else stopCapture();
    }

    private void observeDevice(String body) {
        Device next = new Device();
        next.recordAudio = flag(body, "recordAudio");
        next.notificationsVisible = flag(body, "notificationsVisible");
        next.userForeground = flag(body, "userForeground");
        next.unlocked = flag(body, "unlocked");
        next.keyguardLocked = flag(body, "keyguardLocked");
        next.speechUnavailable = flag(body, "speechUnavailable");
        next.inCall = flag(body, "inCall");
        next.otherAppRecording = flag(body, "otherAppRecording");
        next.micSilenced = flag(body, "micSilenced");
        next.speechPlaying = flag(body, "speechPlaying");
        next.screenInteractive = flag(body, "screenInteractive");
        if (microphoneHeld && next.micSilenced != device.micSilenced) unsilencedSince = next.micSilenced ? -1 : now;
        device = next;
    }

    private static boolean controller(String by) {
        return by.equals("SystemUiLease")
                ? IndicatorLease.admitsController(true, 10_100, new String[] {IndicatorLease.SYSTEMUI_PACKAGE}, true)
                : IndicatorLease.admitsController(false, 10_200, new String[] {"test.host"}, false);
    }

    private static boolean admitted(String body) {
        int uid = (int) number(body, "uid");
        return SenseListeningPolicy.identity(uid, (int) number(body, "foregroundUser"), flag(body, "primaryUser"),
                flag(body, "systemApp"), flag(body, "privileged"), ADMITTED_SIGNER,
                flag(body, "signerAdmitted") ? ADMITTED_SIGNER : OTHER_SIGNER, flag(body, "matchesHost"), flag(body, "solePackage"))
                && SenseListeningPolicy.leaseTarget(LISTENER_PACKAGE, uid,
                        flag(body, "providerPackageMatches") ? LISTENER_PACKAGE : "test.other", (int) number(body, "providerUid"));
    }

    private static int displayState(String display) {
        return switch (display) {
            case "DisplayOn" -> 2;
            case "DisplayDoze" -> 3;
            case "DisplayOff" -> 1;
            case "DisplayUnknown" -> 0;
            default -> throw new IllegalArgumentException("unknown display " + display);
        };
    }

    private void renewLease(String body, boolean replied) {
        boolean recording = SenseListeningPolicy.recording((int) number(body, "uid"), (int) number(body, "recordingUid"), flag(body, "silenced"));
        boolean surface = flag(body, "surface"), chip = flag(body, "chip");
        String display = SenseListeningPolicy.display(displayState(text(body, "display")));
        String reason = SenseListeningPolicy.hiddenReason(surface && (!recording || chip), display, number(body, "msSinceTransition"),
                flag(body, "shadeExpanded"), flag(body, "statusBarHidden"), flag(body, "keyguardShowing"));
        boolean accepted = lease.renew(held, now, boot, surface, SenseListeningPolicy.chipAcknowledged(recording, chip), recording, display, reason);
        if (!accepted || !replied) held = -1;
    }

    private void restartProcess(String cause, long wallClock) {
        if (cause.equals("Reboot")) boot++;
        else if (cause.equals("PackageUpdate")) install++;
        boolean unclean = device.recordAudio && CrashLoopBreaker.uncleanExit(sessionOpen, sessionBoot, boot, sessionInstall, install);
        exits = CrashLoopBreaker.onProcessStart(exits, unclean, wallClock);
        tripped = tripped || CrashLoopBreaker.tripped(exits, wallClock);
        sessionOpen = false;
        processConsent = false;
        indicatorLost = false;
        indicatorPause = ListenerPolicy.IndicatorPause.NONE;
        microphoneHeld = false;
        unsilencedSince = -1;
        lease = new IndicatorLease();
        linked = -1;
        held = -1;
        foreground = false;
        if (ListenerPolicy.foreground(decide())) queued++;
        running = delivered != queued;
    }

    private boolean hearPhrase(String phrase) {
        if (!microphoneHeld || !ListenerPolicy.processesAudio(decide()) || device.speechPlaying) return false;
        String transcript = switch (phrase) {
            case "WakeName" -> "hey eliza";
            case "PauseCommand" -> "eliza stop listening";
            case "OtherSpeech" -> "what a nice day";
            default -> throw new IllegalArgumentException("unknown phrase " + phrase);
        };
        switch (WakePhrase.classify(transcript)) {
            case INVOKE -> {
                if (ListenerPolicy.mayInvokeAssistant(device.keyguardLocked)) {
                    lastWake = "AssistantOpened";
                    out.add("OpenAssistant");
                } else lastWake = "IgnoredWhileLocked";
            }
            case PAUSE_LISTENING -> {
                pause(ListenerPolicy.PAUSE_UNTIL_RESUMED);
                lastWake = "PausedBySpeech";
            }
            case IGNORE -> {}
        }
        return true;
    }

    private boolean unlockedOwner(String by) { return by.equals("Owner") && !(ListenerPolicy.resumeRequiresUnlock() && device.keyguardLocked); }

    private boolean apply(String type, String body, String by) {
        return switch (type) {
            case "turnOn" -> {
                if (!unlockedOwner(by) || !flag(body, "imageAdmitted") || !flag(body, "consented")
                        || !ListenerPolicy.consentPermissionsGranted(flag(body, "recordAudioGranted"), flag(body, "notificationsGranted"))) yield false;
                consented = true;
                processConsent = true;
                setEnabled(true);
                stopConfirmed = false;
                yield true;
            }
            case "resume" -> {
                if (!unlockedOwner(by)) yield false;
                resume();
                yield true;
            }
            case "observeDevice" -> {
                observeDevice(body);
                yield true;
            }
            case "pause" -> {
                long forMs = number(body, "forMs");
                if (by.equals("Owner") && forMs >= 0) pause(forMs % 60_000 == 0 ? ListenerPolicy.pauseUntil(now, (int) (forMs / 60_000)) : now + forMs);
                else if ((by.equals("HostApp") || by.equals("StatusChip")) && forMs == 0) pause(ListenerPolicy.PAUSE_UNTIL_RESUMED);
                else yield false;
                yield true;
            }
            case "turnOff" -> {
                if (!by.equals("Owner") && !by.equals("HostApp")) yield false;
                setEnabled(false);
                yield true;
            }
            case "requestStart" -> {
                if (!ListenerPolicy.foreground(decide())) yield false;
                queued++;
                running = true;
                yield true;
            }
            case "deliverStart" -> {
                if (delivered >= queued) yield false;
                delivered++;
                apply(true, flag(body, "refuses"));
                yield true;
            }
            case "converge" -> {
                if (!running) yield false;
                apply(false, flag(body, "refuses"));
                yield true;
            }
            case "confirmStop" -> {
                if (!by.equals("HostApp")) yield false;
                setEnabled(false);
                ListenerPolicy.State state = decide();
                stopConfirmed = text(body, "settlement").equals("ReplyInTime") && state == ListenerPolicy.State.OFF && !microphoneHeld;
                yield true;
            }
            case "restartProcess" -> {
                restartProcess(text(body, "cause"), number(body, "now"));
                yield true;
            }
            case "hearPhrase" -> hearPhrase(text(body, "phrase"));
            case "acquireLease" -> {
                if (!controller(by) || held >= 0 || !admitted(body)) yield false;
                long generation = lease.acquire(boot);
                linked = generation;
                held = flag(body, "replied") ? generation : -1;
                yield true;
            }
            case "renewLease" -> {
                if (!controller(by) || held < 0 || !admitted(body)) yield false;
                renewLease(body, flag(body, "replied"));
                yield true;
            }
            case "revokeLease" -> {
                if (!controller(by) || held < 0) yield false;
                lease.revoke(held);
                held = -1;
                yield true;
            }
            case "systemUiDied" -> {
                if (linked >= 0) lease.binderDied(linked);
                linked = -1;
                held = -1;
                yield true;
            }
            case "advanceClock" -> {
                long ms = number(body, "ms");
                if (ms <= 0) yield false;
                now += ms;
                yield true;
            }
            default -> throw new IllegalArgumentException("unknown event " + type);
        };
    }

    private Object stored(String name) {
        try {
            Field field = IndicatorLease.class.getDeclaredField(name);
            field.setAccessible(true);
            return field.get(lease);
        } catch (ReflectiveOperationException unreadable) {
            throw new IllegalStateException("IndicatorLease has no readable " + name, unreadable);
        }
    }

    private static String quoted(String value) { return "\"" + value + "\""; }

    private static String display(Object display) {
        if (display == null) return "DisplayUnknown";
        return switch ((String) display) {
            case IndicatorLease.DISPLAY_ON -> "DisplayOn";
            case IndicatorLease.DISPLAY_DOZE -> "DisplayDoze";
            case IndicatorLease.DISPLAY_OFF -> "DisplayOff";
            default -> throw new IllegalStateException("unknown stored display " + display);
        };
    }

    private static String reason(Object reason) {
        return switch ((String) reason) {
            case IndicatorLease.REASON_NONE -> "NoReason";
            case IndicatorLease.REASON_DISPLAY_OFF -> "ReasonDisplayOff";
            case IndicatorLease.REASON_AOD -> "ReasonAod";
            case IndicatorLease.REASON_TRANSITION -> "ReasonTransition";
            case IndicatorLease.REASON_SHADE -> "ReasonShade";
            case IndicatorLease.REASON_FULLSCREEN -> "ReasonFullscreen";
            default -> throw new IllegalStateException("unknown stored reason " + reason);
        };
    }

    private static String ended(IndicatorLease.Loss loss) {
        return switch (loss) {
            case NEVER_ACQUIRED -> "NeverAcquired";
            case EXPIRED -> "Expired";
            case BINDER_DIED -> "BinderDied";
            case REVOKED -> "Revoked";
            default -> throw new IllegalStateException("an ended lease records " + loss);
        };
    }

    private String leaseState() {
        boolean live = (Boolean) stored("live"), acknowledged = live && (Boolean) stored("acknowledged");
        String phase = !live ? "Unleased" : acknowledged ? "Acknowledged" : "Pending";
        String ack = acknowledged
                ? "{\"surface\":" + stored("surfaceVisible") + ",\"chip\":" + stored("chipVisible") + ",\"recording\":" + stored("recordingObserved")
                        + ",\"display\":" + quoted(display(stored("display"))) + ",\"reason\":" + quoted(reason(stored("reason"))) + "}"
                : "{\"surface\":false,\"chip\":false,\"recording\":false,\"display\":\"DisplayOn\",\"reason\":\"NoReason\"}";
        return "{\"now\":" + now + ",\"generation\":" + stored("generation") + ",\"phase\":" + quoted(phase)
                + ",\"expiresAt\":" + (acknowledged ? stored("expiresAt") : 0) + ",\"ack\":" + ack
                + ",\"ended\":" + (live ? "null" : quoted(ended((IndicatorLease.Loss) stored("lastLoss")))) + ",\"held\":" + held + "}";
    }

    private String pauseState() {
        long until = ListenerPolicy.effectivePause(pausedUntil, pauseBoot, boot);
        if (until <= 0) return "{\"tag\":\"NotPaused\"}";
        if (until == ListenerPolicy.PAUSE_UNTIL_RESUMED) return "{\"tag\":\"UntilResumed\"}";
        return "{\"tag\":\"UntilClock\",\"at\":" + until + "}";
    }

    private String deviceState() {
        return "{\"recordAudio\":" + device.recordAudio + ",\"notificationsVisible\":" + device.notificationsVisible
                + ",\"userForeground\":" + device.userForeground + ",\"unlocked\":" + device.unlocked + ",\"keyguardLocked\":" + device.keyguardLocked
                + ",\"speechUnavailable\":" + device.speechUnavailable + ",\"inCall\":" + device.inCall + ",\"otherAppRecording\":" + device.otherAppRecording
                + ",\"micSilenced\":" + device.micSilenced + ",\"speechPlaying\":" + device.speechPlaying + ",\"screenInteractive\":" + device.screenInteractive + "}";
    }

    private String state() {
        decide();
        StringBuilder recent = new StringBuilder();
        for (long exit : exits) recent.append(recent.length() == 0 ? "" : ",").append(exit);
        return "{\"enabled\":" + enabled() + ",\"pause\":" + pauseState() + ",\"tripped\":" + tripped + ",\"recentExits\":[" + recent
                + "],\"indicatorLost\":" + indicatorLost + ",\"device\":" + deviceState() + ",\"lease\":" + leaseState()
                + ",\"unsilencedSince\":" + unsilencedSince + ",\"queued\":" + queued + ",\"delivered\":" + delivered + ",\"stopped\":" + !running
                + ",\"foreground\":" + foreground + ",\"capturing\":" + microphoneHeld + ",\"promotion\":" + quoted(promotion)
                + ",\"stopConfirmed\":" + stopConfirmed + ",\"lastWake\":" + quoted(lastWake) + "}";
    }

    private String effects() {
        StringBuilder list = new StringBuilder();
        for (String effect : out) list.append(list.length() == 0 ? "" : ",").append(quoted(effect));
        return "[" + list + "]";
    }

    private String step(String line) {
        out.clear();
        String body = line.substring(line.indexOf("\"event\""));
        boolean accepted = apply(text(body, "type"), body, sender(line));
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + ",\"out\":" + effects() + "}";
    }

    public static void main(String[] args) throws Exception {
        ListenerReplay replay = new ListenerReplay();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line = input.readLine(); line != null; line = input.readLine()) {
            String reply;
            try {
                if (line.contains("\"event\"")) reply = replay.step(line);
                else {
                    replay = new ListenerReplay();
                    reply = "{\"state\":" + replay.state() + ",\"out\":[]}";
                }
            } catch (RuntimeException failure) {
                reply = "{\"error\":\"" + String.valueOf(failure.getMessage()).replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
            }
            System.out.println(reply);
            System.out.flush();
        }
    }
}
