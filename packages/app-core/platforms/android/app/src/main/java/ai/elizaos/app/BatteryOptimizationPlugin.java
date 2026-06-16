package ai.elizaos.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin that surfaces Android battery-optimization controls to JS.
 *
 * <p>The OS allows-listing dialog can only be requested by user gesture, so
 * the prompt is gated behind {@link #requestExemption(PluginCall)} which JS
 * calls during the onboarding flow when the user explicitly opts in to
 * background activity. {@link #isExempt(PluginCall)} lets JS read the current
 * state to show / hide the prompt.
 *
 * <p>Returns {@code {exempt: false}} on pre-Marshmallow devices, which lack
 * the battery-optimization framework entirely.
 */
@CapacitorPlugin(name = "BatteryOptimization")
public class BatteryOptimizationPlugin extends Plugin {

    @PluginMethod
    public void isExempt(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            result.put("exempt", false);
            result.put("supported", false);
            call.resolve(result);
            return;
        }
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        boolean exempt = pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
        result.put("exempt", exempt);
        result.put("supported", true);
        call.resolve(result);
    }

    @PluginMethod
    public void requestExemption(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            result.put("started", false);
            result.put("supported", false);
            call.resolve(result);
            return;
        }

        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName())) {
            result.put("started", false);
            result.put("supported", true);
            result.put("alreadyExempt", true);
            call.resolve(result);
            return;
        }

        Intent intent = new Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:" + context.getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            result.put("started", true);
            result.put("supported", true);
            call.resolve(result);
        } catch (android.content.ActivityNotFoundException notFound) {
            // Some OEM ROMs strip the settings intent. Fall back to the
            // generic battery-optimization screen so the user can find us
            // manually.
            Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(fallback);
                result.put("started", true);
                result.put("supported", true);
                result.put("fallback", true);
                call.resolve(result);
            } catch (android.content.ActivityNotFoundException fallbackMissing) {
                call.reject("battery_optimization_settings_unavailable", fallbackMissing);
            }
        }
    }
}
