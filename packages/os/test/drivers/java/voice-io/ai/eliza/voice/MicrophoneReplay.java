// spec/os/voice/microphone.md, "Story: Share the microphone between live capture and dictation"; spec/os/voice/microphone.md, "Story: Dictate a draft while live capture was running"
package ai.eliza.voice;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class MicrophoneReplay {
    private static final class Source implements LiveCaptureResource.Source {
        boolean failClose;
        public void requestStop() {}
        public void close() { if (failClose) throw new IllegalStateException("close unconfirmed"); }
    }

    private LocalMicrophoneLease.Slot slot = new LocalMicrophoneLease.Slot();
    private final Map<Long, LocalMicrophoneLease> leases = new HashMap<>();
    private LiveCaptureResource live;
    private LocalMicrophoneLease draft;
    private LocalMicrophoneLease last;

    private static Matcher field(String body, String name, String value) {
        Matcher found = Pattern.compile("\"" + name + "\"\\s*:\\s*" + value).matcher(body);
        if (!found.find()) throw new IllegalArgumentException("an event without " + name + ": " + body);
        return found;
    }

    private static String text(String body, String name) { return field(body, name, "\"(\\w+)\"").group(1); }
    private static boolean flag(String body, String name) { return Boolean.parseBoolean(field(body, name, "(true|false)").group(1)); }
    private static long number(String body, String name) { return Long.parseLong(field(body, name, "(-?\\d+)").group(1)); }

    private boolean reserve(String user, boolean reopen) {
        try {
            switch (user) {
                case "LiveCapture" -> {
                    LiveCaptureResource resource = new LiveCaptureResource(slot);
                    resource.reserveMicrophone(reopen);
                    live = resource;
                    last = resource.microphone();
                }
                case "DraftRecorder" -> {
                    if (reopen) return false;
                    draft = slot.reserve(LocalMicrophoneLease.User.DRAFT_RECORDER, false, null);
                    last = draft;
                }
                case "NoUser" -> { return false; }
                default -> throw new IllegalArgumentException("unknown user " + user);
            }
            leases.put(last.token, last);
        } catch (LocalMicrophoneLease.Refused refused) {
            return true;
        }
        return true;
    }

    private boolean attach() {
        try {
            return live.attach(new Source());
        } catch (IllegalStateException alreadyAttached) {
            return false;
        }
    }

    private boolean liveHolds() { return last != null && last.user == LocalMicrophoneLease.User.LIVE_CAPTURE; }

    private boolean apply(String type, String body) {
        return switch (type) {
            case "reserve" -> reserve(text(body, "user"), flag(body, "reopen"));
            case "opened" -> last != null && (liveHolds() ? attach() : draft.opened());
            case "cancel" -> last != null && (liveHolds() ? live.requestStop() : draft.cancel());
            case "released" -> {
                LocalMicrophoneLease lease = leases.get(number(body, "token"));
                yield lease != null && lease.release();
            }
            case "releaseUnconfirmed" -> last != null && (liveHolds() ? live.openFailed(false) : draft.releaseUnconfirmed());
            case "requestDraft" -> slot.requestDraft(() -> {}, () -> {});
            default -> throw new IllegalArgumentException("unknown event " + type);
        };
    }

    private static String user(LocalMicrophoneLease.User user) {
        if (user == null) return "NoUser";
        return switch (user) { case LIVE_CAPTURE -> "LiveCapture"; case DRAFT_RECORDER -> "DraftRecorder"; };
    }

    private static String phase(LocalMicrophoneLease.Phase phase) {
        return switch (phase) { case FREE -> "Free"; case OPENING -> "Opening"; case RUNNING -> "Running"; case CLOSING -> "Closing"; case UNCONFIRMED -> "Unconfirmed"; };
    }

    private static String refusal(LocalMicrophoneLease.Refusal refusal) {
        return switch (refusal) { case NONE -> "NoRefusal"; case SLOT_BUSY -> "SlotBusy"; case FENCED_REOPEN -> "FencedReopen"; };
    }

    private static String draft(LocalMicrophoneLease.Draft draft) {
        return switch (draft) { case NONE -> "NoDraft"; case DRAINING -> "Draining"; case ADMITTED -> "DraftAdmitted"; case REFUSED -> "DraftRefused"; };
    }

    private static String report(LocalMicrophoneLease.Report report) {
        return switch (report) { case UNREPORTED -> "Unreported"; case STARTED -> "StartReported"; case ENDED -> "EndReported"; };
    }

    private String state() {
        LocalMicrophoneLease.Snapshot s = slot.snapshot();
        return "{\"slot\":{\"user\":\"" + user(s.user) + "\",\"phase\":\"" + phase(s.phase) + "\",\"token\":" + s.token + "},\"issued\":" + s.issued
                + ",\"refusal\":\"" + refusal(s.refusal) + "\",\"reopenFenced\":" + s.reopenFenced + ",\"draft\":\"" + draft(s.draft)
                + "\",\"report\":\"" + report(s.report) + "\"}";
    }

    private String answer(String line) {
        int event = line.indexOf("\"event\"");
        if (event < 0) {
            slot = new LocalMicrophoneLease.Slot();
            leases.clear();
            live = null;
            draft = null;
            last = null;
            return "{\"state\":" + state() + "}";
        }
        String body = line.substring(event);
        boolean accepted = apply(text(body, "type"), body);
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + "}";
    }

    public static void main(String[] args) throws Exception {
        MicrophoneReplay replay = new MicrophoneReplay();
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
