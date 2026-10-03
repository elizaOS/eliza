package example.reminders.fixture;
import android.content.*;
/** Explicit fixture receiver routes only its two configured sources. */
public final class FixtureReceiver extends BroadcastReceiver {
 @Override public void onReceive(Context context,Intent intent){String action=intent.getAction();for(String name:new String[]{"a","b"}){ai.eliza.plugins.reminders.ReminderConfiguration config=FixtureHost.config(name);if(config.remindAction.equals(action)||config.decisionAction.equals(action))FixtureHost.engine(context,name).dispatch(intent);}}
}
