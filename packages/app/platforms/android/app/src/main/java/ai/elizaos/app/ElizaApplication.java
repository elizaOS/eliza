package ai.elizaos.app;

import ai.eliza.plugins.system.reset.DataReset;
import android.app.Application;
import android.content.Context;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.work.Configuration;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

/**
 * Admits a pending "Reset app data" before anything else starts, and allows WorkManager to
 * initialize after a process starts during Direct Boot.
 */
public final class ElizaApplication extends Application implements Configuration.Provider {
    /**
     * The app's single reset coordinator, shared by {@link ElizaDataResetPlugin} and
     * {@link ElizaDataResetRecoveryActivity}.
     */
    static final DataReset DATA_RESET = ElizaDataResetPlugin.coordinator();

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        // Runs before ContentProviders and AndroidX Startup initializers (WorkManager included).
        // With a confirmed reset pending it never returns: it retries Android's clear and stops
        // this process, opening recovery when the start is user-visible. It returns at once with
        // nothing pending, in isolated processes and in the provider-free recovery process.
        DATA_RESET.admitBeforeStartup(base, processName());
        // Code added to onCreate must return early in the recovery process
        // (DATA_RESET.isRecoveryProcess): it starts no app code beyond the recovery activity.
    }

    @NonNull
    @Override
    public Configuration getWorkManagerConfiguration() {
        return new Configuration.Builder().build();
    }

    /** {@link Application#getProcessName()} on API 28+, else this process's command line. */
    static String processName() {
        if (Build.VERSION.SDK_INT >= 28) return Application.getProcessName();
        try (FileInputStream in = new FileInputStream("/proc/self/cmdline")) {
            byte[] buffer = new byte[256];
            int length = in.read(buffer);
            int end = 0;
            while (end < Math.max(length, 0) && buffer[end] != 0) end++;
            return end == 0 ? null : new String(buffer, 0, end, StandardCharsets.UTF_8);
        } catch (Exception unavailable) {
            return null;
        }
    }
}
