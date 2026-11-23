package ai.eliza.voice;

/**
 * Android's on-device recognizer could not transcribe a recording. The caller
 * uses {@link NativeAsr} instead. Pure Java: it has no Android dependency.
 */
public final class RecognizerUnavailable extends Exception {
    /** Reason for a recognizer that did not answer within its limit. */
    public static final String TIMEOUT = "timeout";

    /** True when the recognizer ran past its time limit. */
    public final boolean timedOut;

    public RecognizerUnavailable(String reason) {
        super(reason);
        timedOut = TIMEOUT.equals(reason);
    }
}
