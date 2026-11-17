// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.app.Activity;
import android.content.res.TypedArray;
import android.graphics.Insets;
import android.util.TypedValue;
import android.util.Log;
import android.view.WindowInsets;
import android.os.Bundle;
import android.os.Handler;
import android.os.UpdateEngine;
import android.os.UpdateEngineCallback;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** Standard system-update surface. Intents carry no target, URL or installation authority. */
public final class UpdateActivity extends Activity {
    private final Handler handler = new Handler();
    private TextView status;
    private Button check;
    private ProgressBar progress;
    private UpdateEngine observer;
    private int engineStatus = -1;
    private float engineProgress = -1;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            String message = getSharedPreferences("update-status", MODE_PRIVATE)
                    .getString("message", "Check for a system update");
            boolean busy = UpdateRunner.get(UpdateActivity.this).running()
                    || SystemUpdateJob.requestedPending(UpdateActivity.this);
            String stage = null;
            switch (engineStatus) {
                case UpdateEngine.UpdateStatusConstants.DOWNLOADING:
                    stage = "Installing update"; break;
                case UpdateEngine.UpdateStatusConstants.VERIFYING:
                    stage = "Verifying installation"; break;
                case UpdateEngine.UpdateStatusConstants.FINALIZING:
                    stage = "Finishing installation"; break;
                case UpdateEngine.UpdateStatusConstants.UPDATED_NEED_REBOOT:
                    busy = true; break;
                default: break;
            }
            boolean ready = engineStatus == UpdateEngine.UpdateStatusConstants.UPDATED_NEED_REBOOT;
            boolean measured = ready || (stage != null && engineProgress >= 0 && engineProgress <= 1);
            int percent = ready ? 100 : measured ? Math.round(engineProgress * 100) : 0;
            status.setText(stage == null ? message : stage + (measured ? " " + percent + "%" : ""));
            progress.setVisibility(busy || stage != null ? View.VISIBLE : View.GONE);
            progress.setIndeterminate(!measured);
            if (measured) progress.setProgress(percent);
            check.setVisibility(busy || stage != null ? View.GONE : View.VISIBLE);
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
        status = new TextView(this); status.setTextSize(18);
        TypedArray textColors = obtainStyledAttributes(new int[] { android.R.attr.textColorPrimary });
        status.setTextColor(textColors.getColorStateList(0)); textColors.recycle();
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        content.addView(status);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        LinearLayout.LayoutParams progressLayout = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        progressLayout.setMargins(0, padding, 0, padding);
        content.addView(progress, progressLayout);
        check = new Button(this); check.setText("Check for updates");
        check.setOnClickListener(view -> {
            if (UpdateRunner.get(this).running() || SystemUpdateJob.requestedPending(this)) return;
            UpdateRunner.status(this, "Checking for updates");
            SystemUpdateJob.schedule(this, true, true); handler.removeCallbacks(refresh); handler.post(refresh);
        });
        content.addView(check); setContentView(content); content.requestApplyInsets();
    }
    @Override public void onStart() {
        super.onStart();
        try {
            final UpdateEngine current = new UpdateEngine();
            observer = current;
            if (!current.bind(new UpdateEngineCallback() {
                @Override public void onStatusUpdate(int value, float valueProgress) {
                    if (observer != current) return;
                    engineStatus = value; engineProgress = valueProgress;
                }
                @Override public void onPayloadApplicationComplete(int errorCode) { }
            }, handler)) observer = null;
        } catch (RuntimeException unavailable) {
            observer = null;
            Log.w("ElizaSystemUpdater", "Progress observation unavailable", unavailable);
        }
        handler.removeCallbacks(refresh); handler.post(refresh);
    }
    @Override public void onStop() {
        handler.removeCallbacks(refresh);
        UpdateEngine current = observer; observer = null;
        if (current != null) {
            try { current.unbind(); }
            catch (RuntimeException unavailable) {
                Log.w("ElizaSystemUpdater", "Progress observer detach unconfirmed", unavailable);
            }
        }
        engineStatus = -1; engineProgress = -1;
        super.onStop();
    }
}
