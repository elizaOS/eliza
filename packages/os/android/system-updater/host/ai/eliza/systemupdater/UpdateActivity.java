// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.app.Activity;
import android.graphics.Insets;
import android.util.TypedValue;
import android.view.WindowInsets;
import android.os.Bundle;
import android.os.Handler;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Standard system-update surface. Intents carry no target, URL or installation authority. */
public final class UpdateActivity extends Activity {
    private final Handler handler = new Handler();
    private TextView status;
    private Button check;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            status.setText(getSharedPreferences("update-status", MODE_PRIVATE)
                    .getString("message", "Check for a system update"));
            check.setEnabled(!UpdateRunner.get(UpdateActivity.this).running()
                    && !SystemUpdateJob.requestedPending(UpdateActivity.this));
            handler.postDelayed(this, 2000);
        }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle(R.string.os_update_name);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        TypedValue titleSize = new TypedValue();
        final int titleHeight = getActionBar() != null
                && getTheme().resolveAttribute(android.R.attr.actionBarSize, titleSize, true)
                ? TypedValue.complexToDimensionPixelSize(titleSize.data, getResources().getDisplayMetrics()) : 0;
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(padding + bars.left, padding + bars.top + titleHeight,
                    padding + bars.right, padding + bars.bottom);
            return insets;
        });
        status = new TextView(this); status.setTextSize(18); content.addView(status);
        check = new Button(this); check.setText("Check for updates");
        check.setOnClickListener(view -> {
            if (UpdateRunner.get(this).running() || SystemUpdateJob.requestedPending(this)) return;
            UpdateRunner.status(this, "Checking for updates");
            SystemUpdateJob.schedule(this, true, true); handler.removeCallbacks(refresh); handler.post(refresh);
        });
        content.addView(check); setContentView(content); content.requestApplyInsets();
    }
    @Override public void onStart() { super.onStart(); handler.removeCallbacks(refresh); handler.post(refresh); }
    @Override public void onStop() { handler.removeCallbacks(refresh); super.onStop(); }
}
