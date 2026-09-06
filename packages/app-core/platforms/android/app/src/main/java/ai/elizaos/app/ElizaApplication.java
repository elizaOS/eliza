package ai.elizaos.app;

import android.app.Application;
import androidx.annotation.NonNull;
import androidx.work.Configuration;

/** Allows WorkManager to initialize after a process starts during Direct Boot. */
public final class ElizaApplication extends Application implements Configuration.Provider {
    @NonNull
    @Override
    public Configuration getWorkManagerConfiguration() {
        return new Configuration.Builder().build();
    }
}
