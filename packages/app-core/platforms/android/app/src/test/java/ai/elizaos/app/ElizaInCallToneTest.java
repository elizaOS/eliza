/** Exercises production keypad ownership with deterministic deadlines and a recording Telecom output boundary. */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class ElizaInCallToneTest {
    private final List<String> effects = new ArrayList<>();
    private boolean accepted = true;
    private final ElizaInCallActivity.ToneSession tones = new ElizaInCallActivity.ToneSession(
        new ElizaInCallActivity.ToneSession.Output() {
            @Override public boolean play(String id, char digit) {
                effects.add("play " + id + " " + digit);
                return accepted;
            }
            @Override public void stop(String id) { effects.add("stop " + id); }
        });

    @Test public void replacementStopsOriginalAndOldDeadlineCannotStopNewCall() {
        Runnable first = tones.play("first", '1');
        Runnable second = tones.play("second", '2');
        first.run();
        assertEquals(Arrays.asList("play first 1", "stop first", "play second 2"), effects);
        second.run();
        second.run();
        assertEquals(Arrays.asList("play first 1", "stop first", "play second 2", "stop second"), effects);
    }

    @Test public void selectionChangeStopsOwnerEvenWithoutAnotherDigit() {
        Runnable deadline = tones.play("first", '3');
        tones.retain("first", true);
        assertEquals(Arrays.asList("play first 3"), effects);
        tones.retain("second", true);
        deadline.run();
        assertEquals(Arrays.asList("play first 3", "stop first"), effects);
    }

    @Test public void holdAndScreenStopReleaseToneOnce() {
        Runnable first = tones.play("first", '4');
        tones.retain("first", false);
        Runnable second = tones.play("second", '5');
        tones.stop();
        tones.stop();
        first.run();
        second.run();
        assertEquals(Arrays.asList("play first 4", "stop first", "play second 5", "stop second"), effects);
    }

    @Test public void rejectedReplacementDoesNotOwnOrRetainATone() {
        Runnable first = tones.play("first", '6');
        accepted = false;
        Runnable missing = tones.play("removed", '7');
        first.run();
        missing.run();
        tones.stop();
        assertEquals(Arrays.asList("play first 6", "stop first", "play removed 7"), effects);
    }
}
