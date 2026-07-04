package ai.elizaos.app;

/**
 * Per-turn decode-loop accounting for the bionic inference host (#11913).
 *
 * <p>Owns the invariant the host must never break: <b>one turn performs at
 * most {@code maxTokens} tokens of eval work</b>. Every native
 * {@code nativeLlmStreamNext} call is budgeted with
 * {@code min(stepTokens, cap - produced)}, so the native decode loop can never
 * run past the caller's cap — previously the JNI call always decoded its full
 * 256-token buffer in one shot, so a {@code maxTokens: 20} request paid ~256
 * tokens of decode (~46 s on a Pixel 6a) and the first token frame arrived
 * only after the whole buffer.
 *
 * <p>Pure JVM on purpose: no android.*, no org.json, no JNI. The caller wraps
 * the native step + JSON parse in a {@link StepFn} and (for the streaming op)
 * frame writing in a {@link TokenSink}, which keeps this class testable in a
 * plain unit test ({@code BionicDecodeLoopTest}) — the host-side regression
 * gate for the cap invariant.
 */
final class BionicDecodeLoop {

    /** Default per-turn cap when the request carries none ({@code maxTokens <= 0}). */
    static final int DEFAULT_CAP_TOKENS = 32;
    /** Hard bound of one native call — the JNI-side token buffer size. */
    static final int MAX_STEP_TOKENS = 256;

    /** One native decode step, already parsed from the JNI JSON. */
    static final class Step {
        final String text;
        final int nout;
        final boolean done;

        Step(String text, int nout, boolean done) {
            this.text = text == null ? "" : text;
            this.nout = nout;
            this.done = done;
        }
    }

    /**
     * Runs ONE bounded native decode step: at most {@code stepCap} tokens
     * (1 <= stepCap <= 256). Returns null when the native layer yields nothing
     * (the loop stops rather than spinning).
     */
    interface StepFn {
        Step next(int stepCap) throws Exception;
    }

    /** Receives each non-empty step's text as it decodes (streaming op). */
    interface TokenSink {
        void emit(String text) throws Exception;
    }

    static final class Result {
        /** Committed tokens this turn (== eval work performed, <= the cap). */
        final int produced;
        final String text;

        Result(int produced, String text) {
            this.produced = produced;
            this.text = text;
        }
    }

    private BionicDecodeLoop() {}

    /**
     * Drive one turn's decode. {@code maxTokens <= 0} falls back to
     * {@link #DEFAULT_CAP_TOKENS}; {@code stepTokens} is clamped to
     * {@code [1, MAX_STEP_TOKENS]}. {@code sink} may be null (buffered op).
     */
    static Result run(StepFn step, int maxTokens, int stepTokens, TokenSink sink)
            throws Exception {
        final int cap = maxTokens > 0 ? maxTokens : DEFAULT_CAP_TOKENS;
        int perStep = stepTokens;
        if (perStep < 1) perStep = 1;
        if (perStep > MAX_STEP_TOKENS) perStep = MAX_STEP_TOKENS;

        final StringBuilder sb = new StringBuilder();
        int produced = 0;
        while (produced < cap) {
            final int stepCap = Math.min(perStep, cap - produced);
            final Step s = step.next(stepCap);
            if (s == null) break;
            if (!s.text.isEmpty()) {
                sb.append(s.text);
                if (sink != null) sink.emit(s.text);
            }
            // A step reporting nout=0 without done (e.g. a text-buffer-bound
            // partial step) still counts 1 so the loop provably terminates.
            produced += s.nout > 0 ? s.nout : 1;
            if (s.done) break;
        }
        return new Result(produced, sb.toString());
    }
}
