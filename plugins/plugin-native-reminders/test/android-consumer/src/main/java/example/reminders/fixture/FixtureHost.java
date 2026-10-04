package example.reminders.fixture;
import android.content.Context;
import ai.eliza.plugins.reminders.*;
/** Plain preferences are ONLY synthetic test-fixture storage, never a production secure adapter. */
public final class FixtureHost {
 public static ReminderConfiguration config(String name){return new ReminderConfiguration(
  "fixture-envelope-"+name,"fixture-legacy-"+name,"taps-"+name,"fixture-channel-"+name,
  "Fixture "+name,"Owned synthetic reminder fixture","Synthetic reminder",
  "example.reminders.fixture.REMIND_"+name,"example.reminders.fixture.DECISION_"+name,"example.reminders.fixture.OPEN_"+name,
  "fixture-"+name+":","fixture-decision-"+name+":","fixture-tap-"+name+":",
  "fixture.id","fixture.occurrence","fixture.decision",name+":",FixtureReceiver.class,FixtureActivity.class);}
 public static final SecureStringStore.Factory STORAGE=context -> new SecureStringStore(){
  public String identity(){return "synthetic-private-prefs-v1";}
  public String read(String key){return context.getSharedPreferences("fixture-taps",Context.MODE_PRIVATE).getString(key,null);}
  public void write(String key,String value){if(!context.getSharedPreferences("fixture-taps",Context.MODE_PRIVATE).edit().putString(key,value).commit())throw new IllegalStateException("Fixture write failed");}
 };
 public static ReminderEngine engine(Context context,String name){return ReminderEngine.get(context,config(name),STORAGE);}
}
