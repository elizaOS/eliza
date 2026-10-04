package example.reminders.fixture;
import android.Manifest;
import ai.eliza.plugins.reminders.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
/** Independent registered host; test-only storage is never a production recommendation. */
@CapacitorPlugin(name="ConsumerReminders",permissions={@Permission(alias="notifications",strings={Manifest.permission.POST_NOTIFICATIONS})})
public final class BridgeReminder extends ReminderPlugin {
 public BridgeReminder(){super(configuration(),FixtureHost.STORAGE);}
 public static ReminderConfiguration configuration(){return new ReminderConfiguration(
  "fixture-bridge-envelope","fixture-bridge-legacy","fixture-bridge-taps","fixture-bridge-channel",
  "Bridge fixture","Owned bridge reminders","Synthetic bridge reminder",
  "example.reminders.fixture.BRIDGE_REMIND","example.reminders.fixture.BRIDGE_DECIDE","example.reminders.fixture.BRIDGE_OPEN",
  "bridge-reminder:","bridge-decision:","bridge-tap:","bridge.id","bridge.occurrence","bridge.decision","bridge:",BridgeReceiver.class,BridgeActivity.class);}
 public static ReminderEngine engine(android.content.Context context){return ReminderEngine.get(context,configuration(),FixtureHost.STORAGE);}
}
