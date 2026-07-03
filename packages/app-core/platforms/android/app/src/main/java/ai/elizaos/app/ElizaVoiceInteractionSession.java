package ai.elizaos.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;

import ai.elizaos.app.R;

/**
 * ChatGPT-style voice bar shown over the current app when Eliza is invoked as
 * the digital assistant (long-press power / assist gesture / keyguard).
 *
 * v1 renders a native session UI shell — the voice bar (see
 * {@code res/layout/eliza_voice_interaction_bar.xml}) — so the invocation feels
 * native, then hands off into the Eliza app through the single deep-link spine
 * ({@code elizaos://voice?source=android-assistant-session}) rather than
 * re-implementing chat inside the overlay. The app owns the microphone and the
 * on-device engine, so handing off is both simpler and more robust than
 * duplicating the voice loop here. The distinct {@code source} tag proves in
 * logs which entry point fired.
 */
public class ElizaVoiceInteractionSession extends VoiceInteractionSession {

    private static final String TAG = "ElizaVoiceInteraction";

    /** Distinct source tag so logs prove the assistant-session entry fired. */
    static final String ASSISTANT_SESSION_DEEP_LINK =
            "elizaos://voice?source=android-assistant-session&action=voice&voice=1";

    /**
     * How long the native voice bar stays on screen before we hand off to the
     * app. Long enough to read as a real, native assistant surface (D8); short
     * enough that the app is up almost immediately.
     */
    private static final long HANDOFF_DELAY_MS = 320L;

    private View contentRoot;
    private boolean handedOff = false;

    public ElizaVoiceInteractionSession(Context context) {
        super(context);
    }

    @Override
    public View onCreateContentView() {
        LayoutInflater inflater = LayoutInflater.from(getContext());
        contentRoot = inflater.inflate(R.layout.eliza_voice_interaction_bar, null);
        View bar = contentRoot.findViewById(R.id.eliza_voice_bar_root);
        if (bar != null) {
            // Tapping the bar hands off immediately (in addition to the
            // auto-handoff below), matching the ChatGPT/Claude affordance.
            bar.setOnClickListener(v -> handOffToApp());
        }
        return contentRoot;
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        Log.i(TAG, "[ElizaVoiceInteractionSession] Assistant session shown (flags=" + showFlags + ")");
        if (contentRoot != null) {
            contentRoot.postDelayed(this::handOffToApp, HANDOFF_DELAY_MS);
        } else {
            handOffToApp();
        }
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
        hide();
    }

    @Override
    public void onHide() {
        Log.i(TAG, "[ElizaVoiceInteractionSession] Assistant session hidden");
        handedOff = false;
        super.onHide();
    }
}
