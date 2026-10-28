package ai.eliza.plugins.system.reset;

import ai.eliza.plugins.system.SenseListenerClient;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Visible state for a confirmed reset that could not finish. Declare the host subclass unexported,
 * {@code excludeFromRecents}, {@code singleTask} with its own task affinity, and in the process named
 * by {@link DataReset.Builder#recoveryProcessSuffix}: that process installs none of the host's
 * content providers (no WorkManager or startup initializers) and never starts the agent, renderer,
 * listener or notification code. The Application must return early in that process.
 *
 * <p>It never reports the reset as complete: on success Android stops every process of the package
 * and the next launch is a first run. Destinations are fixed and package-specific: the same-signer
 * listener's own validated settings activity, the dialer and Android Settings.
 */
public abstract class DataResetRecoveryActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView status;
    private Button retry;
    private boolean destroyed;

    /** The host's single reset coordinator. */
    protected abstract DataReset reset();

    /** Product copy; the default names the app by its Android label. */
    protected DataResetCopy copy() {
        CharSequence label = getApplicationInfo().loadLabel(getPackageManager());
        return DataResetCopy.forProduct(label == null || label.length() == 0 ? "this app" : label.toString()).build();
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        DataResetCopy text = copy();
        SenseListenerClient listener = new SenseListenerClient(this);
        boolean installed = listener.installed(), controllable = listener.available();
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(pad, pad + insets.getSystemWindowInsetTop(), pad, pad + insets.getSystemWindowInsetBottom());
            return insets;
        });
        TextView title = new TextView(this);
        title.setText(text.recoveryTitle);
        title.setTextSize(24);
        title.setPadding(0, 0, 0, pad / 2);
        if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
        root.addView(title);
        TextView body = new TextView(this);
        body.setTextSize(16);
        body.setText(text.recoveryBody(reset().lastFailure(this), installed, controllable));
        root.addView(body);
        status = new TextView(this);
        status.setTextSize(16);
        status.setPadding(0, pad / 2, 0, pad / 2);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(status);
        retry = button(root, text.retryLabel, v -> retry(text));
        if (controllable) button(root, text.listenerSettingsLabel, v -> open(new SenseListenerClient(this).settingsIntent(), text));
        button(root, text.phoneLabel, v -> open(new Intent(Intent.ACTION_DIAL), text));
        button(root, text.androidSettingsLabel, v -> open(new Intent(android.provider.Settings.ACTION_SETTINGS), text));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Already finished (or never requested): this surface has nothing to recover.
        if (!reset().pending(this)) {
            open(getPackageManager().getLaunchIntentForPackage(getPackageName()), null);
            finish();
        }
    }

    private Button button(LinearLayout root, String label, View.OnClickListener action) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(action);
        root.addView(button);
        return button;
    }

    private void open(Intent intent, DataResetCopy text) {
        if (intent == null) {
            if (text != null) status.setText(text.screenUnavailable);
            return;
        }
        try {
            startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException unavailable) {
            if (text != null) status.setText(text.screenUnavailable);
        }
    }

    private void retry(DataResetCopy text) {
        retry.setEnabled(false);
        status.setText(text.retrying);
        final Context context = getApplicationContext();
        final DataReset reset = reset();
        Thread attempt = new Thread(() -> {
            DataReset.Outcome outcome = reset.attempt(context, System.currentTimeMillis());
            boolean controllable = new SenseListenerClient(context).available();
            main.post(() -> {
                if (destroyed) return;
                status.setText(text.retryResult(outcome, controllable));
                if (outcome != DataReset.Outcome.DISPATCHED) retry.setEnabled(true);
            });
        }, "eliza-data-reset-recovery");
        attempt.setDaemon(true);
        attempt.start();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        super.onDestroy();
    }
}
