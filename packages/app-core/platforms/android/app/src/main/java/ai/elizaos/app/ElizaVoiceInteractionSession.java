/**
 * Native digital-assistant overlay that hands Android assist invocations into
 * the app's single deep-link spine. The native bar owns only the system-window
 * affordance; microphone and agent behavior stay in the app so every assistant
 * entry point shares one voice implementation and emits a distinct source tag.
 */
package ai.elizaos.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.voice.VoiceInteractionSession;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;

import ai.elizaos.app.R;

/** Android voice-interaction session that renders the bar and opens the app. */
public class ElizaVoiceInteractionSession extends VoiceInteractionSession {

    private static final String TAG = "ElizaVoiceInteraction";

    /** Distinct source tag so logs prove the assistant-session entry fired. */
    static final String ASSISTANT_SESSION_DEEP_LINK =
            "elizaos://voice?source=android-assistant-session&action=voice&voice=1";

    private boolean handedOff = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public ElizaVoiceInteractionSession(Context context) {
        super(context);
    }

    @Override
    public View onCreateContentView() {
        LayoutInflater inflater = LayoutInflater.from(getContext());
        View contentRoot = inflater.inflate(R.layout.eliza_voice_interaction_bar, null);
        View bar = contentRoot.findViewById(R.id.eliza_voice_bar_root);
        if (bar != null) {
            // The bar is also tappable, matching the ChatGPT/Claude affordance.
            bar.setOnClickListener(v -> handOffToApp());
        }
        return contentRoot;
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        Log.i(TAG, "[ElizaVoiceInteractionSession] Assistant session shown (flags=" + showFlags + ")");
        // The native voice bar (onCreateContentView) renders as the session
        // window comes up; hand off to the app from onShow itself so the hand-
        // off never depends on a view-attached timer that a torn-down session
        // window would drop. The assistant context (BAL-allowed) is live here.
        handOffToApp();
    }

    private void handOffToApp() {
        if (handedOff) {
            return;
        }
        handedOff = true;

        Uri uri = Uri.parse(ASSISTANT_SESSION_DEEP_LINK);
        Intent intent = new Intent(getContext(), MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        Log.i(TAG, "[ElizaVoiceInteractionSession] Handing off to Eliza: " + uri);

        // startAssistantActivity launches with the assistant's window context
        // (it can appear above the keyguard when the role supports it); if the
        // platform refuses it, fall back to a plain activity launch so the
        // hand-off still lands.
        try {
            startAssistantActivity(intent);
        } catch (RuntimeException e) {
            Log.w(TAG, "[ElizaVoiceInteractionSession] startAssistantActivity failed; using startActivity", e);
            getContext().startActivity(intent);
        }
        // The framework acknowledges a successful show only after onShow
        // returns. Hiding synchronously makes `cmd voiceinteraction show` report
        // callback failure even though the handoff launched. Leave the native
        // bar visible for one short beat, then dismiss it from the main looper.
        mainHandler.postDelayed(this::hide, 350L);
    }

    @Override
    public void onHide() {
        Log.i(TAG, "[ElizaVoiceInteractionSession] Assistant session hidden");
        handedOff = false;
        super.onHide();
    }
}
