package ai.elizaos.app;

import android.content.Intent;
import android.net.Uri;
import android.os.RemoteException;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;
import android.util.Log;

/**
 * Minimal {@link RecognitionService} required by the VoiceInteractionService
 * contract.
 *
 * {@code res/xml/eliza_voice_interaction_service.xml} MUST name a
 * {@code recognitionService} or the framework rejects
 * {@link ElizaVoiceInteractionService} outright
 * (VoiceInteractionServiceInfo: "No recognitionService specified") and Eliza
 * never appears as an assistant candidate.
 *
 * Eliza's speech recognition runs inside the app (the on-device engine /
 * TalkMode SpeechRecognizer), not through this bound service, so this
 * recognizer follows the same deep-link hand-off every other Eliza entry point
 * uses: it routes the caller into the Eliza app
 * ({@code elizaos://voice?source=android-recognition-service}) and reports that
 * results are delivered in-app. That keeps this a real, resolvable
 * RecognitionService (satisfying the platform contract) without duplicating the
 * engine here.
 */
public class ElizaRecognitionService extends RecognitionService {

    private static final String TAG = "ElizaVoiceInteraction";

    static final String RECOGNITION_DEEP_LINK =
            "elizaos://voice?source=android-recognition-service&action=voice&voice=1";

    @Override
    protected void onStartListening(Intent recognizerIntent, Callback listener) {
        Log.i(TAG, "[ElizaRecognitionService] onStartListening → handing off to Eliza app");
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(Uri.parse(RECOGNITION_DEEP_LINK));
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        try {
            // Recognition results are produced inside the Eliza app, not
            // returned over this bound recognizer, so tell the caller to stop
            // waiting on this channel rather than leaving it hanging.
            listener.error(SpeechRecognizer.ERROR_CLIENT);
        } catch (RemoteException e) {
            Log.w(TAG, "[ElizaRecognitionService] failed to report hand-off to caller", e);
        }
    }

    @Override
    protected void onCancel(Callback listener) {
        Log.i(TAG, "[ElizaRecognitionService] onCancel");
    }

    @Override
    protected void onStopListening(Callback listener) {
        Log.i(TAG, "[ElizaRecognitionService] onStopListening");
    }
}
