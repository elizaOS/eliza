// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Standard system-update surface. Intents carry no target, URL or installation authority. */
public final class UpdateActivity extends Activity {
    private final Handler handler = new Handler();
    private TextView status;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            status.setText(getSharedPreferences("update-status", MODE_PRIVATE)
                    .getString("message", "Check for a system update"));
            handler.postDelayed(this, 2000);
        }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle(R.string.os_update_name);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(padding, padding, padding, padding);
        status = new TextView(this); status.setTextSize(18); content.addView(status);
        Button check = new Button(this); check.setText("Check for updates");
        check.setOnClickListener(view -> {
            UpdateRunner.status(this, "Waiting for enough battery and an unmetered network");
            SystemUpdateJob.schedule(this, true); handler.removeCallbacks(refresh); handler.post(refresh);
        });
        content.addView(check); setContentView(content);
    }
    @Override public void onStart() { super.onStart(); handler.removeCallbacks(refresh); handler.post(refresh); }
    @Override public void onStop() { handler.removeCallbacks(refresh); super.onStop(); }
}
