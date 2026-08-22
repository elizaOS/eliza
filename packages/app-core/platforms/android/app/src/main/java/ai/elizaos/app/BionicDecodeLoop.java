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
import java.util.Collections;
import java.util.List;

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
        return run(step, maxTokens, stepTokens, Collections.emptyList(), sink);
    }

    /**
     * Drive one turn while enforcing caller-supplied textual stop sequences.
     * Only a trailing prefix of a stop marker is withheld from the streaming
     * sink, so markers split across native decode steps never leak while
     * unrelated text is emitted immediately.
     */
    static Result run(StepFn step, int maxTokens, int stepTokens,
                      List<String> stopSequences, TokenSink sink) throws Exception {
        final int cap = maxTokens > 0 ? maxTokens : DEFAULT_CAP_TOKENS;
        int perStep = stepTokens;
        if (perStep < 1) perStep = 1;
        if (perStep > MAX_STEP_TOKENS) perStep = MAX_STEP_TOKENS;

        final StringBuilder sb = new StringBuilder();
        final StringBuilder pending = new StringBuilder();
        boolean stopped = false;
        int produced = 0;
        while (produced < cap) {
            final int stepCap = Math.min(perStep, cap - produced);
            final Step s = step.next(stepCap);
            if (s == null) break;
            if (!s.text.isEmpty()) {
                pending.append(s.text);
                final int stopIndex = earliestStopIndex(pending, stopSequences);
                if (stopIndex >= 0) {
                    commit(pending.substring(0, stopIndex), sb, sink);
                    pending.setLength(0);
                    stopped = true;
                } else {
                    final int safeLength = pending.length()
                        - longestPendingStopPrefix(pending, stopSequences);
                    if (safeLength > 0) {
                        commit(pending.substring(0, safeLength), sb, sink);
                        pending.delete(0, safeLength);
                    }
                }
            }
            // A step reporting nout=0 without done (e.g. a text-buffer-bound
            // partial step) still counts 1 so the loop provably terminates.
            produced += s.nout > 0 ? s.nout : 1;
            if (stopped || s.done) break;
        }
        if (!stopped && pending.length() > 0) {
            commit(pending.toString(), sb, sink);
        }
        return new Result(produced, sb.toString());
    }

    private static void commit(String text, StringBuilder output, TokenSink sink)
            throws Exception {
        if (text.isEmpty()) return;
        output.append(text);
        if (sink != null) sink.emit(text);
    }

    private static int longestPendingStopPrefix(
            CharSequence text, List<String> stopSequences) {
        if (text.length() == 0 || stopSequences == null || stopSequences.isEmpty()) return 0;
        int longest = 0;
        for (String stop : stopSequences) {
            if (stop == null || stop.isEmpty()) continue;
            final int candidateMax = Math.min(text.length(), stop.length());
            for (int length = candidateMax; length > longest; length--) {
                final int suffixStart = text.length() - length;
                boolean matches = true;
                for (int i = 0; i < length; i++) {
                    if (text.charAt(suffixStart + i) != stop.charAt(i)) {
                        matches = false;
                        break;
                    }
                }
                if (matches) {
                    longest = length;
                    break;
                }
            }
        }
        return longest;
    }

    private static int earliestStopIndex(CharSequence text, List<String> stopSequences) {
        if (stopSequences == null || stopSequences.isEmpty()) return -1;
        final String value = text.toString();
        int earliest = -1;
        for (String stop : stopSequences) {
            if (stop == null || stop.isEmpty()) continue;
            final int index = value.indexOf(stop);
            if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index;
        }
        return earliest;
    }
}
