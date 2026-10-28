/**
 * Presents and controls live Telecom calls without requiring agent or WebView startup.
 * The host's non-exported subclass accepts only app-owned call IDs. Telecom callbacks drive
 * its state, including call removal, audio routing and multiple simultaneous calls.
 */
package ai.eliza.plugins.phone;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.VideoProfile;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.List;

public abstract class TelecomCallActivity extends Activity {
    /** The heading the call screen shows above the caller, for example the product name. */
    protected abstract String title();

    private final Runnable changed = this::render;
    private String selected;
    private final Handler toneHandler = new Handler(Looper.getMainLooper());
    private final ToneSession tones = new ToneSession(new ToneSession.Output() {
        @Override public boolean play(String id, char digit) { return TelecomCallService.playDtmfTone(id, digit); }
        @Override public void stop(String id) { TelecomCallService.stopDtmfTone(id); }
    });

    /** Owns one call's tone; delayed cleanup may never stop its replacement. */
    public static final class ToneSession {
        public interface Output {
            boolean play(String id, char digit);
            void stop(String id);
        }
        private final Output output;
        private String callId;
        private Object admission;

        public ToneSession(Output output) { this.output = output; }

        public Runnable play(String id, char digit) {
            stop();
            if (!output.play(id, digit)) return () -> {};
            callId = id;
            Object current = new Object();
            admission = current;
            return () -> { if (admission == current) stop(); };
        }

        public void retain(String id, boolean active) {
            if (!active || !id.equals(callId)) stop();
        }

        public void stop() {
            String previous = callId;
            callId = null;
            admission = null;
            if (previous != null) output.stop(previous);
        }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) setShowWhenLocked(true);
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
        if (state == null) acceptIntent(getIntent());
        else selected = state.getString("callId");
    }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        acceptIntent(intent);
        render();
    }

    @Override public void onStart() {
        super.onStart();
        TelecomCallService.observe(changed);
        render();
    }

    @Override public void onStop() {
        tones.stop();
        toneHandler.removeCallbacksAndMessages(null);
        TelecomCallService.unobserve(changed);
        super.onStop();
    }

    @Override public void onSaveInstanceState(Bundle state) {
        state.putString("callId", selected);
        super.onSaveInstanceState(state);
    }

    private void acceptIntent(Intent intent) {
        tones.stop();
        selected = intent.getStringExtra("callId");
        Call call = TelecomCallService.call(selected);
        if (call == null) return;
        String command = intent.getStringExtra("command");
        if ("answer".equals(command) && call.getState() == Call.STATE_RINGING) {
            TelecomCallService.answerCall(selected, VideoProfile.STATE_AUDIO_ONLY);
        } else if ("reject".equals(command) && call.getState() == Call.STATE_RINGING) {
            TelecomCallService.rejectCall(selected, false, null);
        } else if ("disconnect".equals(command)) {
            TelecomCallService.disconnectCall(selected);
        }
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private TextView text(String value, int size) {
        TextView text = new TextView(this);
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(Color.WHITE);
        text.setGravity(Gravity.CENTER);
        text.setPadding(dp(12), dp(12), dp(12), dp(12));
        return text;
    }

    private Button button(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setAllCaps(false);
        button.setMinHeight(dp(56));
        button.setBackgroundTintList(new ColorStateList(
            new int[][] {new int[] {android.R.attr.state_pressed}, new int[] {}},
            new int[] {Color.rgb(167, 64, 18), Color.rgb(196, 66, 18)}));
        button.setOnClickListener(view -> action.run());
        parent.addView(button, new LinearLayout.LayoutParams(-1, -2));
        return button;
    }

    private void render() {
        List<String> ids = TelecomCallService.callIds();
        if (ids.isEmpty()) { tones.stop(); finish(); return; }
        if (!ids.contains(selected)) selected = ids.get(0);
        Call call = TelecomCallService.call(selected);
        if (call == null) { tones.stop(); finish(); return; }
        String id = selected;
        int state = call.getState();
        tones.retain(id, state == Call.STATE_ACTIVE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) setTurnScreenOn(state == Call.STATE_RINGING);
        else if (state == Call.STATE_RINGING) getWindow().addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        content.setPadding(dp(24), dp(32), dp(24), dp(32));
        content.setBackgroundColor(Color.rgb(25, 22, 21));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(content);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(scroll);
        content.addView(text(title(), 18));
        Call.Details details = call.getDetails();
        Uri handle = details == null ? null : details.getHandle();
        content.addView(text(handle == null ? "Unknown caller" : handle.getSchemeSpecificPart(), 32));
        content.addView(text(stateLabel(state), 20));
        if (state == Call.STATE_RINGING) {
            button(content, "Answer", () -> TelecomCallService.answerCall(id, VideoProfile.STATE_AUDIO_ONLY));
            button(content, "Decline", () -> TelecomCallService.rejectCall(id, false, null));
        } else if (state != Call.STATE_DISCONNECTED && state != Call.STATE_DISCONNECTING) {
            button(content, "End call", () -> TelecomCallService.disconnectCall(id));
            CallAudioState audio = TelecomCallService.audioState();
            if (audio != null) {
                button(content, audio.isMuted() ? "Unmute" : "Mute", () -> TelecomCallService.mute(!audio.isMuted()));
                int phoneRoutes = audio.getSupportedRouteMask() & CallAudioState.ROUTE_WIRED_OR_EARPIECE;
                if ((audio.getSupportedRouteMask() & CallAudioState.ROUTE_SPEAKER) != 0 && phoneRoutes != 0) {
                    boolean speaker = audio.getRoute() == CallAudioState.ROUTE_SPEAKER;
                    button(content, speaker ? "Use phone audio" : "Use speaker", () -> TelecomCallService.route(
                        speaker ? phoneRoutes : CallAudioState.ROUTE_SPEAKER));
                }
            }
            if (details != null && details.can(Call.Details.CAPABILITY_HOLD)) {
                button(content, state == Call.STATE_HOLDING ? "Resume call" : "Hold", () -> TelecomCallService.holdCall(id, state != Call.STATE_HOLDING));
            }
            if (state == Call.STATE_ACTIVE) {
                for (String digits : new String[] {"123", "456", "789", "*0#"}) {
                    LinearLayout row = new LinearLayout(this);
                    for (char digit : digits.toCharArray()) {
                        Button key = button(row, String.valueOf(digit), () -> {
                            toneHandler.postDelayed(tones.play(id, digit), 200);
                        });
                        key.setLayoutParams(new LinearLayout.LayoutParams(0, dp(64), 1));
                    }
                    content.addView(row, new LinearLayout.LayoutParams(-1, -2));
                }
            }
        }
        for (String other : ids) {
            if (!other.equals(id)) button(content, "View other call", () -> { selected = other; render(); });
        }
        scroll.requestApplyInsets();
    }

    public static String stateLabel(int state) {
        switch (state) {
            case Call.STATE_RINGING: return "Incoming call";
            case Call.STATE_DIALING: return "Dialing";
            case Call.STATE_CONNECTING: return "Connecting";
            case Call.STATE_ACTIVE: return "Connected";
            case Call.STATE_HOLDING: return "On hold";
            case Call.STATE_DISCONNECTING: return "Ending call";
            case Call.STATE_DISCONNECTED: return "Call ended";
            case Call.STATE_SELECT_PHONE_ACCOUNT: return "Choose a phone account";
            default: return "Preparing call";
        }
    }
}
