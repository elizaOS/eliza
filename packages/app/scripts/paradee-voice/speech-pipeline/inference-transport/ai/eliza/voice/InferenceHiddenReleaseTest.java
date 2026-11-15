package ai.eliza.voice;

import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.res.AssetManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * Host-JVM run of ElizaInferencePlugin's hidden release with the session double: hidden and idle
 * releases the transport's holds, shown, busy, in-flight or host-held work keeps them, and the
 * next request loads again on the same session.
 */
public final class InferenceHiddenReleaseTest {
    static final long WINDOW = 300;

    /** A host that opts in once window is set (below 0: the transport's default), with a hold it can set. */
    static final class Host extends ElizaInferencePlugin {
        volatile long window = -1;
        volatile boolean holds;
        @Override protected long idleReleaseMillis() { return 0; }
        @Override protected long hiddenReleaseMillis() { return window < 0 ? super.hiddenReleaseMillis() : window; }
        @Override protected boolean holdsModels() { return holds; }
    }

    static final InferenceSession SESSION = VoiceAssets.SHARED;
    static int requests;

    static void check(boolean value, String what) { if (!value) throw new AssertionError(what); }

    static boolean waitFor(BooleanSupplier done) throws InterruptedException {
        for (int i = 0; i < 100 && !done.getAsBoolean(); i++) Thread.sleep(20);
        return done.getAsBoolean();
    }

    static PluginCall speak(Host host) {
        PluginCall call = new PluginCall().put("requestId", "r" + ++requests).put("text", "Hello");
        host.synthesize(call);
        return call;
    }

    static PluginCall hear(Host host) {
        PluginCall call = new PluginCall().put("requestId", "r" + ++requests)
                .put("pcm16Base64", java.util.Base64.getEncoder().encodeToString(new byte[3200]));
        host.transcribe(call);
        return call;
    }

    static void settled(PluginCall call) throws Exception {
        check("RESOLVED".equals(call.settled.get(5, TimeUnit.SECONDS)), "the request resolves");
    }

    /** Starts a request that stays in flight until the returned latch opens. */
    static CountDownLatch inFlight(Host host, boolean hearing, PluginCall[] out) throws Exception {
        CountDownLatch gate = new CountDownLatch(1), started = new CountDownLatch(1);
        SESSION.gate = gate;
        SESSION.started = started;
        out[0] = hearing ? hear(host) : speak(host);
        check(started.await(5, TimeUnit.SECONDS), "the request starts");
        SESSION.gate = null;
        SESSION.started = null;
        return gate;
    }

    public static void main(String[] args) throws Exception {
        try { run(); } catch (Throwable failure) { failure.printStackTrace(); System.exit(1); }
        System.out.println("PASS inference hidden release");
        System.exit(0);
    }

    static void run() throws Exception {
        Context context = new Context();
        Plugin.context = context;
        Host host = new Host();
        host.load();
        ComponentCallbacks2 trims = context.callbacks.get(0);

        // Off by default (the transport's own hiddenReleaseMillis): hidden and idle keeps the models.
        settled(speak(host));
        host.handleOnStop();
        Thread.sleep(2 * WINDOW);
        check(SESSION.releases == 0, "no hidden release unless the host opts in");

        // Shown keeps the models, also through a running-moderate trim and a UI_HIDDEN that comes
        // late, after the host was shown again.
        host.handleOnStart();
        host.window = WINDOW;
        trims.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE);
        trims.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN);
        Thread.sleep(2 * WINDOW);
        check(SESSION.releases == 0, "a shown host keeps the models");

        // Hidden and idle for the window: both lanes' holds go, after the window.
        settled(hear(host));
        long spoke = System.nanoTime();
        host.handleOnStop();
        check(waitFor(() -> SESSION.frees == 1), "a hidden, idle host releases the models");
        check((System.nanoTime() - spoke) / 1_000_000 >= WINDOW, "not before the window");
        check(SESSION.releases == 2 && SESSION.releasedWhileRunning == 0, "both lanes release, nothing running");

        // A UI_HIDDEN after the stop, with nothing done since, releases nothing more.
        trims.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN);
        Thread.sleep(2 * WINDOW);
        check(SESSION.releases == 2, "nothing held, nothing released again");

        // The next request loads again, lazily, on the same session and configure is not repeated.
        settled(speak(host));
        check(SESSION.loads == 2 && VoiceAssets.opened == 1, "the next request loads again on the same session");

        // In-flight work is never cancelled: the release waits for it and the window after it.
        PluginCall[] call = new PluginCall[1];
        CountDownLatch gate = inFlight(host, false, call);
        Thread.sleep(2 * WINDOW);
        check(SESSION.frees == 1 && !call[0].settled.isDone(), "speech in flight keeps the models");
        gate.countDown();
        settled(call[0]);
        check(waitFor(() -> SESSION.frees == 2), "released after the speech and the window");
        check(SESSION.releasedWhileRunning == 0, "never while running");

        // A transcription in flight on the hearing lane keeps them too, while the speech worker is free.
        gate = inFlight(host, true, call);
        trims.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN);
        Thread.sleep(2 * WINDOW);
        check(SESSION.frees == 2 && !call[0].settled.isDone(), "a transcription in flight keeps the models");
        gate.countDown();
        settled(call[0]);
        check(waitFor(() -> SESSION.frees == 3) && SESSION.releasedWhileRunning == 0, "released after the transcription");

        // The host's own hold (for example audio focus) keeps them.
        host.handleOnStart();
        settled(speak(host));
        host.holds = true;
        host.handleOnStop();
        Thread.sleep(2 * WINDOW);
        check(SESSION.frees == 3, "the host's hold keeps the models");
        host.holds = false;
        check(waitFor(() -> SESSION.frees == 4), "released once the host lets go");

        // Shown again before the window: the pending check stops.
        host.handleOnStart();
        settled(speak(host));
        host.handleOnStop();
        host.handleOnStart();
        Thread.sleep(3 * WINDOW);
        check(SESSION.frees == 4, "shown again keeps the models");

        // releaseModels: releases now when quiet, refuses while work runs or nothing is held.
        gate = inFlight(host, true, call);
        check(!host.releaseModels().get(5, TimeUnit.SECONDS), "no release while a request is running");
        gate.countDown();
        settled(call[0]);
        check(host.releaseModels().get(5, TimeUnit.SECONDS) && SESSION.frees == 5, "releaseModels releases a quiet transport");
        check(!host.releaseModels().get(5, TimeUnit.SECONDS), "nothing held, nothing released");
        settled(speak(host));
        check(SESSION.loads == 6 && SESSION.releasedWhileRunning == 0, "a released transport speaks again, loading once");

        // Hidden with nothing held, so no check is left; then a status call with speechLanguage
        // loads the voice and the ASR. A hidden check releases them after the window.
        check(host.releaseModels().get(5, TimeUnit.SECONDS) && SESSION.frees == 6, "released before hiding");
        host.handleOnStop();
        Thread.sleep(2 * WINDOW);
        AssetManager.packaged = true;
        PluginCall status = new PluginCall().put("speechLanguage", "en");
        host.status(status);
        settled(status);
        check(waitFor(() -> SESSION.loads == 7), "the status warm-up loads the models");
        check(waitFor(() -> SESSION.frees == 7), "models a status call loaded while hidden are released");
        check(SESSION.releasedWhileRunning == 0, "never while the warm-up runs");
        AssetManager.packaged = false;

        // A destroyed bridge: its window is kept and its holdsModels is no longer asked.
        host.handleOnStart();
        settled(speak(host));
        host.holds = true;
        host.handleOnStop();
        Thread.sleep(2 * WINDOW);
        check(SESSION.frees == 7, "the host's hold keeps the models");
        host.handleOnDestroy();
        check(waitFor(() -> SESSION.frees == 8), "after the bridge is destroyed, its window still releases");
        check(SESSION.releasedWhileRunning == 0, "never while running");
    }
}
