/** Exercises what the call screen says and offers for each Telecom state, without Android views. */
package ai.eliza.plugins.phone;

import static org.junit.Assert.assertEquals;
import android.telecom.Call;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class TelecomCallPresentationTest {
    private static List<String> offered(int state, boolean audioKnown, boolean speakerRoutable, boolean canHold) {
        TelecomCallPresentation.Controls controls = TelecomCallPresentation.controls(state, audioKnown, speakerRoutable, canHold);
        List<String> names = new ArrayList<>();
        if (controls.answer) names.add("answer");
        if (controls.decline) names.add("decline");
        if (controls.mute) names.add("mute");
        if (controls.keypad) names.add("keypad");
        if (controls.speaker) names.add("speaker");
        if (controls.hold) names.add("hold");
        if (controls.end) names.add("end");
        return names;
    }

    @Test public void initialsAreTheFirstAndLastWordsLetters() {
        assertEquals("AL", TelecomCallPresentation.initials("Ada Lovelace", true));
        assertEquals("AL", TelecomCallPresentation.initials("  ada   king  lovelace ", true));
        assertEquals("A", TelecomCallPresentation.initials("Ada", false));
        assertEquals("DL", TelecomCallPresentation.initials("Dr. Ada M. Lovelace", true));
        assertEquals("ÉM", TelecomCallPresentation.initials("émilie (work) martin", true));
        assertEquals("林", TelecomCallPresentation.initials("林小明", true));
        assertEquals("I", TelecomCallPresentation.initials("411 Info", true));
    }

    @Test public void aNumberWithNoNameIsAHashAndAWithheldCallerIsBlank() {
        assertEquals("#", TelecomCallPresentation.initials(null, true));
        assertEquals("#", TelecomCallPresentation.initials("+1 555 0123", true));
        assertEquals("", TelecomCallPresentation.initials(null, false));
        assertEquals("", TelecomCallPresentation.initials("   ", false));
    }

    @Test public void elapsedTimeGainsAnHourFieldOnlyFromOneHour() {
        assertEquals("0:00", TelecomCallPresentation.elapsed(0));
        assertEquals("0:00", TelecomCallPresentation.elapsed(999));
        assertEquals("0:01", TelecomCallPresentation.elapsed(1000));
        assertEquals("1:05", TelecomCallPresentation.elapsed(65_000));
        assertEquals("59:59", TelecomCallPresentation.elapsed(3_599_999));
        assertEquals("1:00:00", TelecomCallPresentation.elapsed(3_600_000));
        assertEquals("12:03:09", TelecomCallPresentation.elapsed(43_389_000));
        assertEquals("0:00", TelecomCallPresentation.elapsed(-5000));
    }

    @Test public void secondaryLineFollowsTheCallState() {
        assertEquals("(555) 010-0123", TelecomCallPresentation.secondaryLine(Call.STATE_RINGING, "(555) 010-0123", 0, 9000));
        assertEquals("", TelecomCallPresentation.secondaryLine(Call.STATE_RINGING, null, 0, 9000));
        for (int calling : new int[] {Call.STATE_NEW, Call.STATE_DIALING, Call.STATE_CONNECTING, Call.STATE_SELECT_PHONE_ACCOUNT}) {
            assertEquals("Calling…", TelecomCallPresentation.secondaryLine(calling, "(555) 010-0123", 0, 9000));
        }
        assertEquals("1:15", TelecomCallPresentation.secondaryLine(Call.STATE_ACTIVE, "(555) 010-0123", 5000, 80_000));
        // The clock moved back after the call connected.
        assertEquals("0:00", TelecomCallPresentation.secondaryLine(Call.STATE_ACTIVE, null, 5000, 4000));
        // Telecom has not reported a connect time: no invented duration.
        assertEquals("", TelecomCallPresentation.secondaryLine(Call.STATE_ACTIVE, null, 0, 80_000));
        assertEquals("On hold", TelecomCallPresentation.secondaryLine(Call.STATE_HOLDING, null, 5000, 80_000));
        assertEquals("Call ended", TelecomCallPresentation.secondaryLine(Call.STATE_DISCONNECTING, null, 5000, 80_000));
        assertEquals("Call ended", TelecomCallPresentation.secondaryLine(Call.STATE_DISCONNECTED, null, 5000, 80_000));
    }

    @Test public void timerTicksOnTheCallsOwnSecondBoundary() {
        assertEquals(1000, TelecomCallPresentation.untilNextSecond(5000, 5000));
        assertEquals(750, TelecomCallPresentation.untilNextSecond(5000, 6250));
        assertEquals(1, TelecomCallPresentation.untilNextSecond(5000, 6999));
        assertEquals(1000, TelecomCallPresentation.untilNextSecond(0, 6250));
        assertEquals(1000, TelecomCallPresentation.untilNextSecond(5000, 4000));
    }

    @Test public void aRingingCallOffersOnlyAnswerAndDecline() {
        assertEquals(Arrays.asList("answer", "decline"), offered(Call.STATE_RINGING, true, true, true));
        assertEquals(Arrays.asList("answer", "decline"), offered(Call.STATE_RINGING, false, false, false));
    }

    @Test public void aLiveCallOffersEachControlOnlyWhenItCanWork() {
        assertEquals(Arrays.asList("mute", "keypad", "speaker", "hold", "end"), offered(Call.STATE_ACTIVE, true, true, true));
        assertEquals(Arrays.asList("keypad", "end"), offered(Call.STATE_ACTIVE, false, true, false));
        assertEquals(Arrays.asList("mute", "keypad", "end"), offered(Call.STATE_ACTIVE, true, false, false));
        // The keypad sends tones only into a connected call.
        assertEquals(Arrays.asList("mute", "speaker", "hold", "end"), offered(Call.STATE_HOLDING, true, true, true));
        assertEquals(Arrays.asList("mute", "speaker", "end"), offered(Call.STATE_DIALING, true, true, false));
        assertEquals(Arrays.asList("end"), offered(Call.STATE_CONNECTING, false, false, false));
    }

    @Test public void anEndedCallOffersNothing() {
        assertEquals(Arrays.asList(), offered(Call.STATE_DISCONNECTING, true, true, true));
        assertEquals(Arrays.asList(), offered(Call.STATE_DISCONNECTED, true, true, true));
    }

    @Test public void chipsAndTogglesSayTheirState() {
        assertEquals("Ada Lovelace · On hold", TelecomCallPresentation.chipLabel("Ada Lovelace", Call.STATE_HOLDING));
        assertEquals("Unknown · Incoming", TelecomCallPresentation.chipLabel("Unknown", Call.STATE_RINGING));
        assertEquals("(555) 010-0123 · Active", TelecomCallPresentation.chipLabel("(555) 010-0123", Call.STATE_ACTIVE));
        assertEquals("Ada · Calling…", TelecomCallPresentation.chipLabel("Ada", Call.STATE_DIALING));
        assertEquals("Ada · Call ended", TelecomCallPresentation.chipLabel("Ada", Call.STATE_DISCONNECTED));
        assertEquals("Mute, on", TelecomCallPresentation.toggleDescription("Mute", true));
        assertEquals("Speaker, off", TelecomCallPresentation.toggleDescription("Speaker", false));
    }
}
