package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/**
 * Host-side regression gate for issue #11913: the bionic host must perform at
 * most {@code maxTokens} tokens of eval work per turn, across however many
 * native {@code nativeLlmStreamNext} calls that takes, and must surface the
 * decode incrementally (per bounded step) instead of one 256-token buffer.
 *
 * <p>The fake {@link BionicDecodeLoop.StepFn} stands in for the JNI call ONLY —
 * the unit under test is the host's decode-loop accounting, which is exactly
 * the code that was broken on the Pixel 6a bench (a maxTokens:20 request paid
 * ~256 tokens ≈ 46 s of decode because the cap never reached the native call).
 * The native side's own per-call contract ({@code tokens_cap} bounds one call)
 * is upstream llama.cpp-fork behavior verified on-device.
 */
public final class BionicDecodeLoopTest {

    /** Scripted native step: decodes exactly the requested budget per call. */
    private static final class GreedyFake implements BionicDecodeLoop.StepFn {
        final List<Integer> requestedCaps = new ArrayList<>();
        int totalDecoded = 0;

        @Override
        public BionicDecodeLoop.Step next(int stepCap) {
            requestedCaps.add(stepCap);
            totalDecoded += stepCap;
            // One fake token piece per decoded token, so text length tracks
            // eval work: "t" * stepCap.
            final StringBuilder sb = new StringBuilder();
            for (int i = 0; i < stepCap; i++) sb.append('t');
            return new BionicDecodeLoop.Step(sb.toString(), stepCap, false);
        }
    }

    // ── THE #11913 regression: maxTokens=20 ⇒ ≤ 20 tokens of eval work ────

    @Test
    public void maxTokens20PerformsAtMost20TokensOfEvalWork() throws Exception {
        final GreedyFake fake = new GreedyFake();
        final BionicDecodeLoop.Result r = BionicDecodeLoop.run(
            fake, 20, BionicDecodeLoop.MAX_STEP_TOKENS, null);
        // The buffered op used to hand the native layer its whole 256-token
        // buffer; now the very first call must already be capped to 20.
        assertEquals(Arrays.asList(20), fake.requestedCaps);
        assertEquals(20, fake.totalDecoded);
        assertEquals(20, r.produced);
        assertTrue("eval work must not exceed the cap", fake.totalDecoded <= 20);
    }

    @Test
    public void streamingStepBudgetsEveryNativeCallWithinTheCap() throws Exception {
        final GreedyFake fake = new GreedyFake();
        final BionicDecodeLoop.Result r = BionicDecodeLoop.run(fake, 20, 8, null);
        // 20 tokens at 8/step: 8 + 8 + 4 — the last call shrinks to the
        // remaining budget instead of overshooting.
        assertEquals(Arrays.asList(8, 8, 4), fake.requestedCaps);
        assertEquals(20, fake.totalDecoded);
        assertEquals(20, r.produced);
        assertEquals(20, r.text.length());
    }

    @Test
    public void capDefaultsWhenRequestCarriesNone() throws Exception {
        final GreedyFake fake = new GreedyFake();
        final BionicDecodeLoop.Result r = BionicDecodeLoop.run(
            fake, 0, BionicDecodeLoop.MAX_STEP_TOKENS, null);
        assertEquals(BionicDecodeLoop.DEFAULT_CAP_TOKENS, r.produced);
        assertEquals(BionicDecodeLoop.DEFAULT_CAP_TOKENS, fake.totalDecoded);
    }

    @Test
    public void stepTokensAreClampedToTheJniBuffer() throws Exception {
        final GreedyFake big = new GreedyFake();
        BionicDecodeLoop.run(big, 1000, 5000, null);
        for (int cap : big.requestedCaps) {
            assertTrue("step must never exceed the 256-token JNI buffer",
                cap <= BionicDecodeLoop.MAX_STEP_TOKENS);
        }
        final GreedyFake tiny = new GreedyFake();
        BionicDecodeLoop.run(tiny, 3, 0, null);
        assertEquals(Arrays.asList(1, 1, 1), tiny.requestedCaps);
    }

    // ── EOS / early-stop behavior ───────────────────────────────────────────

    @Test
    public void eosStopsTheTurnEarly() throws Exception {
        final List<Integer> caps = new ArrayList<>();
        final BionicDecodeLoop.StepFn nineTokenReply = stepCap -> {
            caps.add(stepCap);
            if (caps.size() == 1) {
                return new BionicDecodeLoop.Step("Hello wor", 8, false);
            }
            // Second step hits EOS after one more token.
            return new BionicDecodeLoop.Step("ld", 1, true);
        };
        final BionicDecodeLoop.Result r =
            BionicDecodeLoop.run(nineTokenReply, 256, 8, null);
        assertEquals(9, r.produced);
        assertEquals("Hello world", r.text);
        assertEquals(Arrays.asList(8, 8), caps);
    }

    @Test
    public void doneOnTheExactCapBoundaryDoesNotRequestAnotherStep() throws Exception {
        final List<Integer> caps = new ArrayList<>();
        final BionicDecodeLoop.StepFn fn = stepCap -> {
            caps.add(stepCap);
            return new BionicDecodeLoop.Step("xxxxxxxx", 8, caps.size() == 2);
        };
        final BionicDecodeLoop.Result r = BionicDecodeLoop.run(fn, 16, 8, null);
        assertEquals(16, r.produced);
        assertEquals(2, caps.size());
    }

    // ── Incremental emission (TTFT decoupling) ─────────────────────────────

    @Test
    public void sinkReceivesEachStepChunkInOrder() throws Exception {
        final List<String> frames = new ArrayList<>();
        final String[] pieces = {"The ", "quick ", "fox"};
        final int[] call = {0};
        final BionicDecodeLoop.StepFn fn = stepCap -> {
            final int i = call[0]++;
            return new BionicDecodeLoop.Step(pieces[i], 2, i == pieces.length - 1);
        };
        final BionicDecodeLoop.Result r =
            BionicDecodeLoop.run(fn, 64, 2, frames::add);
        assertEquals(Arrays.asList("The ", "quick ", "fox"), frames);
        assertEquals("The quick fox", r.text);
        assertEquals(6, r.produced);
    }

    @Test
    public void emptyStepTextIsNotEmittedAsAFrame() throws Exception {
        final List<String> frames = new ArrayList<>();
        final int[] call = {0};
        final BionicDecodeLoop.StepFn fn = stepCap -> {
            final int i = call[0]++;
            if (i == 0) return new BionicDecodeLoop.Step("", 1, false);
            return new BionicDecodeLoop.Step("done", 1, true);
        };
        BionicDecodeLoop.run(fn, 8, 4, frames::add);
        assertEquals(Arrays.asList("done"), frames);
    }

    // ── Termination + failure propagation ──────────────────────────────────

    @Test
    public void zeroNoutStepsStillTerminate() throws Exception {
        final int[] calls = {0};
        final BionicDecodeLoop.StepFn stuck = stepCap -> {
            calls[0]++;
            return new BionicDecodeLoop.Step("", 0, false);
        };
        final BionicDecodeLoop.Result r = BionicDecodeLoop.run(stuck, 5, 8, null);
        // Each zero-progress step is counted as 1 so the loop provably ends.
        assertEquals(5, calls[0]);
        assertEquals(5, r.produced);
    }

    @Test
    public void nullStepEndsTheTurnWithPartialOutput() throws Exception {
        final int[] call = {0};
        final BionicDecodeLoop.StepFn fn = stepCap -> {
            if (call[0]++ == 0) return new BionicDecodeLoop.Step("partial", 4, false);
            return null;
        };
        final BionicDecodeLoop.Result r = BionicDecodeLoop.run(fn, 64, 4, null);
        assertEquals(4, r.produced);
        assertEquals("partial", r.text);
    }

    @Test
    public void stepFailurePropagatesToTheCaller() {
        final BionicDecodeLoop.StepFn broken = stepCap -> {
            throw new IllegalStateException("llm_stream_next: invalid session");
        };
        try {
            BionicDecodeLoop.run(broken, 20, 8, null);
            fail("expected the native failure to propagate");
        } catch (Exception e) {
            assertTrue(e instanceof IllegalStateException);
        }
    }

    @Test
    public void sinkFailurePropagatesToTheCaller() {
        final BionicDecodeLoop.StepFn fn = stepCap ->
            new BionicDecodeLoop.Step("chunk", 1, false);
        final BionicDecodeLoop.TokenSink deadPeer = text -> {
            throw new java.io.IOException("peer closed");
        };
        try {
            BionicDecodeLoop.run(fn, 20, 8, deadPeer);
            fail("expected the sink failure to propagate");
        } catch (Exception e) {
            assertTrue(e instanceof java.io.IOException);
        }
    }

    // ── streamStep resolution (request → env → default → clamp) ───────────

    @Test
    public void streamStepResolutionOrder() {
        assertEquals(4, ElizaBionicInferenceServer.resolveStreamStepTokens(4, "16"));
        assertEquals(16, ElizaBionicInferenceServer.resolveStreamStepTokens(0, "16"));
        assertEquals(8, ElizaBionicInferenceServer.resolveStreamStepTokens(0, null));
        assertEquals(8, ElizaBionicInferenceServer.resolveStreamStepTokens(-3, " "));
        assertEquals(8, ElizaBionicInferenceServer.resolveStreamStepTokens(0, "junk"));
        assertEquals(BionicDecodeLoop.MAX_STEP_TOKENS,
            ElizaBionicInferenceServer.resolveStreamStepTokens(9999, null));
        assertEquals(BionicDecodeLoop.MAX_STEP_TOKENS,
            ElizaBionicInferenceServer.resolveStreamStepTokens(0, "1024"));
    }

    @Test
    public void stepValueObjectNormalizesNullText() {
        final BionicDecodeLoop.Step s = new BionicDecodeLoop.Step(null, 1, false);
        assertEquals("", s.text);
    }
}
