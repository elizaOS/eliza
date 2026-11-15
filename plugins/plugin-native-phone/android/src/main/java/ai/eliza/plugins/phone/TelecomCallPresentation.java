/**
 * What the call screen says and offers for a call, separate from how {@link TelecomCallActivity}
 * draws it. Everything here is a pure function of Telecom state, so it runs on the JVM.
 */
package ai.eliza.plugins.phone;

import android.telecom.Call;
import java.util.Locale;

public final class TelecomCallPresentation {
    private TelecomCallPresentation() {}

    /** The controls a call offers. A ringing call offers only answer and decline. */
    public static final class Controls {
        public final boolean answer, decline, end, mute, keypad, speaker, hold;

        Controls(boolean answer, boolean decline, boolean end, boolean mute, boolean keypad, boolean speaker, boolean hold) {
            this.answer = answer; this.decline = decline; this.end = end; this.mute = mute;
            this.keypad = keypad; this.speaker = speaker; this.hold = hold;
        }
    }

    /**
     * @param audioKnown Telecom reported an audio state, which mute and the speaker route need.
     * @param speakerRoutable the speaker and an earpiece or wired route are both supported.
     * @param canHold the call has {@code CAPABILITY_HOLD}.
     */
    public static Controls controls(int state, boolean audioKnown, boolean speakerRoutable, boolean canHold) {
        if (state == Call.STATE_RINGING) return new Controls(true, true, false, false, false, false, false);
        if (state == Call.STATE_DISCONNECTED || state == Call.STATE_DISCONNECTING) {
            return new Controls(false, false, false, false, false, false, false);
        }
        return new Controls(false, false, true, audioKnown, state == Call.STATE_ACTIVE,
            audioKnown && speakerRoutable, canHold);
    }

    /**
     * Up to two letters for the avatar: the first letter of the first and of the last word of the
     * name. A number with no name is {@code #}; a withheld caller has no initials.
     */
    public static String initials(String name, boolean hasNumber) {
        int first = -1, last = -1;
        if (name != null) {
            for (String word : name.trim().split("\\s+")) {
                int letter = initial(word);
                if (letter < 0) continue;
                if (first < 0) first = letter;
                else last = letter;
            }
        }
        if (first < 0) return hasNumber ? "#" : "";
        StringBuilder letters = new StringBuilder().appendCodePoint(Character.toUpperCase(first));
        if (last >= 0) letters.appendCodePoint(Character.toUpperCase(last));
        return letters.toString();
    }

    private static int initial(String word) {
        for (int i = 0; i < word.length(); ) {
            int point = word.codePointAt(i);
            if (Character.isLetter(point)) return point;
            i += Character.charCount(point);
        }
        return -1;
    }

    /** {@code m:ss}, or {@code h:mm:ss} from one hour. A negative duration is {@code 0:00}. */
    public static String elapsed(long millis) {
        long seconds = Math.max(0, millis) / 1000;
        long hours = seconds / 3600, minutes = seconds % 3600 / 60;
        seconds %= 60;
        return hours > 0
            ? String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, seconds)
            : String.format(Locale.ROOT, "%d:%02d", minutes, seconds);
    }

    /**
     * The one line under the caller's name.
     *
     * @param numberWhenNamed the formatted number when a name is shown above it, otherwise null.
     * @param connectMillis {@code Call.Details.getConnectTimeMillis()}; 0 when Telecom has not set it.
     */
    public static String secondaryLine(int state, String numberWhenNamed, long connectMillis, long nowMillis) {
        switch (state) {
            case Call.STATE_RINGING: return numberWhenNamed == null ? "" : numberWhenNamed;
            case Call.STATE_ACTIVE: return connectMillis > 0 ? elapsed(nowMillis - connectMillis) : "";
            case Call.STATE_HOLDING: return "On hold";
            case Call.STATE_DISCONNECTING:
            case Call.STATE_DISCONNECTED: return "Call ended";
            default: return "Calling…";
        }
    }

    /** Milliseconds until the elapsed time next changes, so each tick lands on a second boundary. */
    public static long untilNextSecond(long connectMillis, long nowMillis) {
        long elapsed = nowMillis - connectMillis;
        return connectMillis > 0 && elapsed >= 0 ? 1000 - elapsed % 1000 : 1000;
    }

    /** A chip for a call that is not the one shown: who it is and what it is doing. */
    public static String chipLabel(String who, int state) {
        String doing;
        switch (state) {
            case Call.STATE_RINGING: doing = "Incoming"; break;
            case Call.STATE_ACTIVE: doing = "Active"; break;
            case Call.STATE_HOLDING: doing = "On hold"; break;
            case Call.STATE_DISCONNECTING:
            case Call.STATE_DISCONNECTED: doing = "Call ended"; break;
            default: doing = "Calling…";
        }
        return who + " · " + doing;
    }

    /** What a screen reader says for a toggle, for example "Mute, on". */
    public static String toggleDescription(String label, boolean on) {
        return label + (on ? ", on" : ", off");
    }
}
