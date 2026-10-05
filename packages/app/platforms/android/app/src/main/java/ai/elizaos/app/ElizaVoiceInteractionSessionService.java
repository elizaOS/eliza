package ai.elizaos.app;

import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;
import android.util.Log;

/**
 * Factory the framework binds to (guarded by {@code BIND_VOICE_INTERACTION})
 * to create an {@link ElizaVoiceInteractionSession} whenever the user invokes
 * Eliza as the digital assistant (long-press power, assist gesture, keyguard
 * launch, …). Referenced from {@code res/xml/eliza_voice_interaction_service.xml}
 * via {@code android:sessionService}.
 */
public class ElizaVoiceInteractionSessionService extends VoiceInteractionSessionService {

    private static final String TAG = "ElizaVoiceInteraction";

    @Override
    public VoiceInteractionSession onNewSession(Bundle args) {
        Log.i(TAG, "[ElizaVoiceInteractionSessionService] Creating Eliza assistant session");
        return new ElizaVoiceInteractionSession(this);
    }
}
