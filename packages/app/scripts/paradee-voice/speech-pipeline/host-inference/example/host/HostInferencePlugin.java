package example.host;

import ai.eliza.voice.ElizaInferencePlugin;
import ai.eliza.voice.InferenceSession;
import ai.eliza.voice.ParadeeVoice;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Compile-only: a host outside the package passes its policy through every transport hook. */
@CapacitorPlugin(name = "HostSpeech")
public final class HostInferencePlugin extends ElizaInferencePlugin {
    private volatile boolean refusing;

    @Override protected void admit(PluginCall call) throws Refusal {
        if (refusing) throw new Refusal("Speech is paused", "PAUSED");
    }

    @Override public void load() {
        // Process-wide and fixed once any voice loads, possibly by another consumer: not in configure.
        try { ParadeeVoice.setThreadCount(2); } catch (IllegalStateException alreadyFixed) {}
        super.load();
    }

    @Override protected void configure(InferenceSession session) {
        if (session.speechLanguages().contains("es")) session.speedRange("es", 0.5f, 1.5f);
    }

    @Override protected void describe(PluginCall call, JSObject status) {
        status.put("host", true);
    }

    @Override protected JSObject hear(Transcription transcription) throws Exception {
        transcription.cancelWith(() -> {});
        if (transcription.pcm16.length == 0) throw new Refusal("Expected audio", "INVALID_INPUT");
        return super.hear(transcription);
    }

    @Override protected long idleReleaseMillis() { return 0; }

    /** Models stay resident while shown; a minute after the host is hidden and idle, they go. */
    @Override protected long hiddenReleaseMillis() { return 60000; }

    /** For example: speech this host synthesized is still playing under audio focus. */
    @Override protected boolean holdsModels() { return refusing; }

    @Override protected boolean answerBeforeInstall() { return true; }

    @Override protected String failureCode(String code, Throwable failure) {
        return "SPEECH_FAILED".equals(code) && failure instanceof java.io.IOException ? "VOICE_UNAVAILABLE" : code;
    }

    @Override protected void resolved(PluginCall call, JSObject result) {}

    @PluginMethod public void pause(PluginCall call) {
        refusing = true;
        cancelAll();
        call.resolve();
    }

    /** Releases the models now when nothing is queued or running; the next request loads them. */
    @PluginMethod public void trim(PluginCall call) {
        releaseModels();
        call.resolve();
    }
}
