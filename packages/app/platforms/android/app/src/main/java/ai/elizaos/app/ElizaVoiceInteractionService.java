package ai.elizaos.app;

import android.service.voice.VoiceInteractionService;
import android.util.Log;

/**
 * Digital-assistant entry point for Eliza (Android {@code ROLE_ASSISTANT}).
 *
 * Declaring a {@link VoiceInteractionService} is what surfaces Eliza under
 * Settings → Apps → Default apps → Digital assistant app on retail devices and
 * lets the assist gesture / long-press-power invoke Eliza over whatever app is
 * in the foreground. The service itself is a thin lifecycle marker; the
 * user-facing work happens in {@link ElizaVoiceInteractionSession}, created by
 * {@link ElizaVoiceInteractionSessionService}.
 *
 * The framework requires the paired session + recognition services named in
 * {@code res/xml/eliza_voice_interaction_service.xml}
 * ({@code android:sessionService} + {@code android:recognitionService}); if
 * either is missing the component fails to parse
 * (VoiceInteractionServiceInfo: "No recognitionService specified") and Eliza
 * never shows up as an assistant candidate.
 *
 * {@link ElizaAssistActivity} stays as the {@code ACTION_ASSIST} fallback for
 * OEM flows that still deliver the assist intent directly; when the role is
 * held the framework routes the assist gesture to this VoiceInteractionService
 * session instead.
 */
public class ElizaVoiceInteractionService extends VoiceInteractionService {

    private static final String TAG = "ElizaVoiceInteraction";

    @Override
    public void onReady() {
        super.onReady();
        Log.i(TAG, "[ElizaVoiceInteractionService] Eliza assistant ready");
    }

    @Override
    public void onShutdown() {
        Log.i(TAG, "[ElizaVoiceInteractionService] Eliza assistant shutting down");
        super.onShutdown();
    }
}
