package example.reminders.fixture;
import android.content.*;
public final class BridgeReceiver extends ai.eliza.plugins.reminders.ReminderReceiver {
 @Override protected ai.eliza.plugins.reminders.ReminderEngine engine(Context context){return BridgeReminder.engine(context);}
}
