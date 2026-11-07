package ai.eliza.plugins.system.reset;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;

/**
 * Native disclosure, then a fresh Android device-credential confirmation, then {@link DataReset}.
 * Renderer arguments carry no authority: {@code review()} takes none, and only this plugin's own
 * dialog and Android's credential result can record a reset.
 *
 * <p>Results are {@code {status, message}}: {@code cancelled} or {@code unavailable} when nothing
 * was reset. A confirmed reset never resolves as completed: Android stops the process, and an
 * unfinished reset opens the host's recovery activity instead.
 *
 * <p>Hosts subclass this with their own {@code @CapacitorPlugin(name=...)} (the annotation is not
 * inherited), return their shared {@link DataReset} and, optionally, product copy.
 */
public abstract class DataResetPlugin extends Plugin {
    private final ResetAuthorization authorization = new ResetAuthorization();
    private long authenticationToken;
    private PluginCall authenticationCall;
    private AlertDialog review;
    private boolean destroyed;

    /** The host's single reset coordinator, shared with its Application and recovery activity. */
    protected abstract DataReset reset();

    /** Product copy; the default names the app by its Android label. */
    protected DataResetCopy copy() {
        CharSequence label = getContext().getApplicationInfo().loadLabel(getContext().getPackageManager());
        return DataResetCopy.forProduct(label == null || label.length() == 0 ? "this app" : label.toString()).build();
    }

    private static void result(PluginCall call, String status, String message) {
        JSObject value = new JSObject();
        value.put("status", status);
        value.put("message", message);
        call.resolve(value);
    }

    @PluginMethod
    public void review(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            DataResetCopy text = copy();
            if (destroyed || getActivity().isFinishing()) {
                result(call, "cancelled", text.reviewClosed);
                return;
            }
            final long owner;
            try {
                owner = authorization.begin();
            } catch (IllegalStateException busy) {
                result(call, "unavailable", text.reviewBusy);
                return;
            }
            review = new AlertDialog.Builder(getActivity())
                    .setTitle(text.reviewTitle)
                    .setMessage(text.disclosure)
                    .setNegativeButton(text.cancelLabel, (dialog, which) -> {
                        authorization.retire();
                        result(call, "cancelled", text.nothingReset);
                    })
                    .setOnCancelListener(dialog -> {
                        authorization.retire();
                        result(call, "cancelled", text.nothingReset);
                    })
                    .setPositiveButton(text.continueLabel, (dialog, which) -> {
                        if (destroyed || !authorization.confirm(owner)) {
                            result(call, "cancelled", text.reviewExpired);
                            return;
                        }
                        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
                        Intent unlock = keyguard == null ? null : keyguard.createConfirmDeviceCredentialIntent(text.credentialTitle, text.credentialDescription);
                        if (unlock == null) {
                            authorization.retire();
                            result(call, "unavailable", text.noScreenLock);
                            return;
                        }
                        try {
                            authenticationToken = owner;
                            authenticationCall = call;
                            startActivityForResult(call, unlock, "authenticated");
                        } catch (RuntimeException unavailable) {
                            authorization.retire();
                            result(call, "unavailable", text.authenticationUnavailable);
                        }
                    })
                    .create();
            review.show();
        });
    }

    @ActivityCallback
    private void authenticated(PluginCall call, ActivityResult response) {
        DataResetCopy text = copy();
        if (call == null || call != authenticationCall || destroyed
                || !authorization.authenticate(authenticationToken, response.getResultCode() == Activity.RESULT_OK)) {
            if (call != null) result(call, "cancelled", text.authenticationCancelled);
            return;
        }
        authenticationCall = null;
        DataReset reset = reset();
        Context context = getContext().getApplicationContext();
        try {
            reset.record(context);
        } catch (Exception failure) {
            result(call, "unavailable", text.prepareFailed);
            if (reset.pending(context)) reset.dispatchAndExit(context);
            return;
        }
        // Recorded first: whatever happens below, the next launch completes the reset.
        showProgress(text);
        final Handler main = new Handler(Looper.getMainLooper());
        reset.dispatchAfterBeforeDispatch(context, DataReset.INTERACTIVE_DEADLINE_MS, new DataReset.Scheduler() {
            @Override public void post(Runnable task) { main.post(task); }
            @Override public void postDelayed(Runnable task, long delayMs) { main.postDelayed(task, delayMs); }
        });
    }

    /** Keep the confirmed reset visible until Android dispatches it. */
    private void showProgress(DataResetCopy text) {
        try {
            if (review != null) review.dismiss();
            new AlertDialog.Builder(getActivity()).setTitle(text.progressTitle).setMessage(text.progressMessage).setCancelable(false).create().show();
        } catch (RuntimeException unavailable) {
            // The reset proceeds either way.
        }
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        authenticationCall = null;
        authorization.retire();
        if (review != null) review.dismiss();
        super.handleOnDestroy();
    }
}
