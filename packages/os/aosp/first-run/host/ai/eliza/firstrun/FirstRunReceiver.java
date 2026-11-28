// spec/os/image/firstRun.md, "First run is done only when every required role reads back as the product's, and otherwise retries at the next completed boot"; spec/os/image/firstRun.md, "Done and retired are final"
package ai.eliza.firstrun;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.util.Log;
import java.util.List;

public final class FirstRunReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                attempt(app);
            } finally {
                pending.finish();
            }
        }, "eliza-first-run").start();
    }

    private static void attempt(Context context) {
        Resources resources = context.getResources();
        FirstRunPolicy.Descriptor descriptor = FirstRunPolicy.descriptor(resources.getBoolean(R.bool.first_run_enabled),
                List.of(resources.getStringArray(R.array.first_run_roles)));
        FirstRunPolicy.Result result = FirstRunPolicy.attempt(descriptor, new AndroidPort(context));
        Log.println(result.attempt() == FirstRunPolicy.Attempt.ATTEMPTED || result.attempt() == FirstRunPolicy.Attempt.FINISHED ? Log.INFO : Log.ERROR,
                AndroidPort.TAG, "first run attempt=" + result.attempt() + " state=" + FirstRunPolicy.encode(result.state()));
        if (result.state().phase().finished())
            context.getPackageManager().setComponentEnabledSetting(new ComponentName(context, FirstRunReceiver.class),
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
    }
}
