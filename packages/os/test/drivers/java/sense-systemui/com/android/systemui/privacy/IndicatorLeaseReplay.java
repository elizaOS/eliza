// spec/os/voice/indicatorLease.md, "Story: Never listen without a visible indicator"; spec/os/voice/indicatorLease.md, "Story: Acknowledge only what SystemUI itself measures"
package com.android.systemui.privacy;

import ai.eliza.sense.IndicatorLease;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class IndicatorLeaseReplay {
    private static final String LISTENER_PACKAGE = "test.listener";
    private static final String ADMITTED_SIGNER = "a".repeat(64);
    private static final String OTHER_SIGNER = "b".repeat(64);
    private static final long BOOT = 1;

    private IndicatorLease lease = new IndicatorLease();
    private long now;
    private long linked = -1;
    private long held = -1;

    private static Matcher field(String body, String name, String value) {
        Matcher found = Pattern.compile("\"" + name + "\"\\s*:\\s*" + value).matcher(body);
        if (!found.find()) throw new IllegalArgumentException("an event without " + name + ": " + body);
        return found;
    }

    private static boolean flag(String body, String name) {
        return Boolean.parseBoolean(field(body, name, "(true|false)").group(1));
    }

    private static long number(String body, String name) {
        return Long.parseLong(field(body, name, "(-?\\d+)").group(1));
    }

    private static String text(String body, String name) {
        return field(body, name, "\"(\\w+)\"").group(1);
    }

    private static boolean controller(String line) {
        Matcher by = Pattern.compile("\"by\"\\s*:\\s*\"(\\w+)\"").matcher(line);
        boolean systemUi = by.find() && by.group(1).equals("SystemUi");
        return systemUi
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

    private boolean acquire(String body, boolean replied) {
        long generation = lease.acquire(BOOT);
        linked = generation;
        held = replied ? generation : -1;
        return true;
    }

    private boolean renew(String body, boolean replied) {
        boolean recording = SenseListeningPolicy.recording((int) number(body, "uid"), (int) number(body, "recordingUid"), flag(body, "silenced"));
        boolean surface = flag(body, "surface"), chip = flag(body, "chip");
        String display = SenseListeningPolicy.display(displayState(text(body, "display")));
        String reason = SenseListeningPolicy.hiddenReason(surface && (!recording || chip), display, number(body, "msSinceTransition"),
                flag(body, "shadeExpanded"), flag(body, "statusBarHidden"), flag(body, "keyguardShowing"));
        boolean accepted = lease.renew(held, now, BOOT, surface, SenseListeningPolicy.chipAcknowledged(recording, chip), recording, display, reason);
        if (!accepted || !replied) held = -1;
        return true;
    }

    private boolean revoke() {
        long current = held;
        held = -1;
        lease.revoke(current);
        return true;
    }

    private boolean apply(String type, String body, String line) {
        return switch (type) {
            case "acquire" -> controller(line) && held < 0 && admitted(body) && acquire(body, flag(body, "replied"));
            case "renew" -> controller(line) && held >= 0 && admitted(body) && renew(body, flag(body, "replied"));
            case "revoke" -> controller(line) && held >= 0 && revoke();
            case "advance" -> {
                long ms = number(body, "ms");
                if (ms <= 0) yield false;
                now += ms;
                lease.verdict(now, BOOT, false, true);
                yield true;
            }
            case "systemUiDied" -> {
                if (linked >= 0) lease.binderDied(linked);
                linked = -1;
                held = -1;
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

    private static String quoted(String value) {
        return "\"" + value + "\"";
    }

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

    private String state() {
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

    private String answer(String line) {
        int event = line.indexOf("\"event\"");
        if (event < 0) {
            lease = new IndicatorLease();
            now = 0;
            linked = -1;
            held = -1;
            return "{\"state\":" + state() + "}";
        }
        String body = line.substring(event);
        boolean accepted = apply(text(body, "type"), body, line);
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + "}";
    }

    public static void main(String[] args) throws Exception {
        IndicatorLeaseReplay replay = new IndicatorLeaseReplay();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line = input.readLine(); line != null; line = input.readLine()) {
            String reply;
            try {
                reply = replay.answer(line);
            } catch (RuntimeException failure) {
                reply = "{\"error\":\"" + String.valueOf(failure.getMessage()).replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
            }
            System.out.println(reply);
            System.out.flush();
        }
    }
}
