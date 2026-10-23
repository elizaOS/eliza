package ai.eliza.voice;

/**
 * Picks the recognizer for one recording. Android's on-device recognizer is
 * tried first when it is available; {@link NativeAsr} is used when it cannot
 * transcribe. A recognizer can also report an English model and then return
 * no words for audio that holds speech. Then the recording is transcribed
 * again with the native ASR, and {@code demote} turns Android's recognizer
 * off for the process. A timeout demotes it too. A recording with no speech
 * ({@link #containsSpeech}) may come back empty.
 *
 * <p>No Android types, so the rule runs on the JVM.
 */
final class TranscriptionRoute {
    interface Platform {
        String transcribe() throws RecognizerUnavailable;
    }

    interface Native {
        /** Null when the native ASR cannot be opened. */
        String transcribe();
    }

    interface Log {
        void line(String message);
    }

    /** What was heard and by which engine: "android" or "asr". */
    static final class Heard {
        final String text;
        final String engine;
        /** Android returned no words for speech; the native ASR heard this recording. */
        final boolean fellBack;
        /** This recording turned Android's recognizer off for the process. */
        final boolean demoted;

        Heard(String text, String engine, boolean fellBack, boolean demoted) {
            this.text = text;
            this.engine = engine;
            this.fellBack = fellBack;
            this.demoted = demoted;
        }
    }

    /** 20 ms frames at 16 kHz. */
    static final int FRAME = 320;
    /** Frame RMS at or above this (about -40 dBFS) counts as sound. */
    static final double SPEECH_RMS = 0.01;
    /** At least this many sounding frames (0.3 s) count as speech. */
    static final int SPEECH_FRAMES = 15;

    private TranscriptionRoute() {}

    /**
     * Transcribes {@code pcm16k} (16-bit little-endian mono). Returns null
     * only when Android gave no answer and the native ASR cannot be opened.
     */
    static Heard transcribe(byte[] pcm16k, boolean platformAvailable, Platform platform, Native nativeAsr,
            Runnable demote, Log log) {
        boolean timedOut = false;
        if (platformAvailable) {
            String text = null;
            try {
                text = platform.transcribe();
            } catch (RecognizerUnavailable unavailable) {
                // A recognizer that timed out on one recording does it again
                // on the next, so a timeout demotes it. Other failures use the
                // native ASR for this recording only.
                timedOut = unavailable.timedOut;
                if (timedOut) demote.run();
                log.line("android recognizer unavailable (" + unavailable.getMessage() + "); using ASR"
                        + (timedOut ? " for this process" : ""));
            }
            if (text != null && (!text.trim().isEmpty() || !containsSpeech(pcm16k))) {
                return new Heard(text, "android", false, false);
            }
            if (text != null) {
                demote.run();
                log.line("android recognizer heard no words in speech; using ASR for this process");
                String heard = nativeAsr.transcribe();
                return heard == null ? new Heard(text, "android", false, true) : new Heard(heard, "asr", true, true);
            }
        }
        String heard = nativeAsr.transcribe();
        return heard == null ? null : new Heard(heard, "asr", false, timedOut);
    }

    /**
     * Time limit for Android's recognizer on one recording. It reads the
     * pipe at about real time, so the limit is the audio length plus 4 s,
     * within 6 s and 64 s.
     */
    static long limitMillis(int pcm16kBytes) {
        long audioMs = Math.max(0, pcm16kBytes) / 32L;
        return Math.max(6_000L, Math.min(64_000L, 4_000L + audioMs));
    }

    /** True when the recording has at least 0.3 s of 20 ms frames at or above -40 dBFS RMS. */
    static boolean containsSpeech(byte[] pcm16k) {
        int sounding = 0;
        int samples = pcm16k.length / 2;
        for (int start = 0; start + FRAME <= samples; start += FRAME) {
            double sum = 0;
            for (int i = start; i < start + FRAME; i++) {
                int at = i * 2;
                double sample = (short) ((pcm16k[at] & 0xff) | (pcm16k[at + 1] << 8)) / 32768.0;
                sum += sample * sample;
            }
            if (Math.sqrt(sum / FRAME) >= SPEECH_RMS && ++sounding >= SPEECH_FRAMES) return true;
        }
        return false;
    }
}
