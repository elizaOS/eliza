package ai.eliza.plugins.reminders;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
/** Keep the existing host receiver FQCN; subclass and return the same singleton as the bridge. */
public abstract class ReminderReceiver extends BroadcastReceiver {
 protected abstract ReminderEngine engine(Context context);
 @Override public final void onReceive(Context context,Intent intent){engine(context).dispatch(intent);}
}
