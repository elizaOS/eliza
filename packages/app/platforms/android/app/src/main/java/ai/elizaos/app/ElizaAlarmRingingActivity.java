package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Date;

/** Native alarm controls work over the lock screen without an agent or WebView. */
public final class ElizaAlarmRingingActivity extends Activity {
    private String selectedId;
    private long selectedGeneration = -1;
    private int selectedQueued = -1;
    private boolean selectedMuted;
    private final Runnable changed = this::render;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        render();
    }

    @Override public void onStart() {
        super.onStart();
        ElizaAlarmRingingService.observe(changed);
        render();
    }

    @Override public void onStop() {
        ElizaAlarmRingingService.unobserve(changed);
        super.onStop();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private TextView text(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(Color.WHITE);
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(12), dp(12), dp(12), dp(12));
        return view;
    }

    private void button(LinearLayout parent, String label, ElizaAlarms.Occurrence occurrence, String action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setAllCaps(false);
        button.setMinHeight(dp(64));
        button.setBackgroundTintList(new ColorStateList(
            new int[][] {new int[] {android.R.attr.state_pressed}, new int[] {}},
            new int[] {Color.rgb(167, 64, 18), Color.rgb(196, 66, 18)}));
        button.setOnClickListener(view -> {
            // A rendered button retains its own occurrence token, never a later alarm's.
            if (ElizaAlarms.active(this, occurrence.id, occurrence.generation) == null) {
                render();
                return;
            }
            startService(ElizaAlarmRingingService.command(this, action, occurrence.id, occurrence.generation));
            button.setEnabled(false);
            selectedGeneration = -1;
        });
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2);
        layout.topMargin = dp(12);
        parent.addView(button, layout);
    }

    private void render() {
        ElizaAlarms.Occurrence occurrence = ElizaAlarms.active(this);
        if (occurrence == null) { finish(); return; }
        int queued = ElizaAlarms.queuedCount(this);
        boolean muted = ElizaAlarmRingingService.alarmSoundMuted(this);
        if (occurrence.id.equals(selectedId) && occurrence.generation == selectedGeneration &&
            queued == selectedQueued && muted == selectedMuted) return;
        selectedId = occurrence.id;
        selectedGeneration = occurrence.generation;
        selectedQueued = queued;
        selectedMuted = muted;
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER);
        content.setPadding(dp(24), dp(32), dp(24), dp(32));
        content.setBackgroundColor(Color.rgb(25, 22, 21));
        content.addView(text("Eliza · Alarm", 18));
        content.addView(text(DateFormat.getTimeFormat(this).format(new Date(occurrence.fireAt)), 56));
        content.addView(text(occurrence.label.isEmpty() ? "Alarm" : occurrence.label, 28));
        if (muted) {
            content.addView(text("Alarm sound is muted in Android settings", 18));
        }
        if (queued > 0) content.addView(text(queued == 1 ? "1 more alarm waiting" : queued + " more alarms waiting", 18));
        button(content, "Stop", occurrence, ElizaAlarmRingingService.ACTION_STOP);
        button(content, "Snooze 5 min", occurrence, ElizaAlarmRingingService.ACTION_SNOOZE);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(content);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(scroll);
        scroll.requestApplyInsets();
    }
}
