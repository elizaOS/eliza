package ai.eliza.plugins.reminders;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
/** Native identity admission only; never schedules, posts, or changes device settings. */
@RunWith(AndroidJUnit4.class)
public final class ReminderEngineIdentityInstrumentedTest {
 public static final class Receiver extends BroadcastReceiver {public void onReceive(Context c,Intent i){}}
 private ReminderConfiguration configuration(String id){return new ReminderConfiguration(id+"_envelope",id+"_legacy",id+"_taps",id+"_channel","Test reminders","Test channel","Test",id+".remind",id+".decide",id+".open","example:"+id+"/alarm/","example:"+id+"/decision/","example:"+id+"/tap/","id","occurrence","decision",id+":",Receiver.class,Activity.class);}
 private SecureStringStore.Factory store(String identity){return context->new SecureStringStore(){public String identity(){return identity;}public String read(String key){throw new AssertionError("Identity admission must not read user state");}public void write(String key,String value){throw new AssertionError("Identity admission must not write user state");}};}
 @Test public void instancesShareEngineOnlyForExactStorageAndHostIdentity(){
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();String id="test_"+UUID.randomUUID().toString().replace("-","");ReminderConfiguration configuration=configuration(id);
  ReminderEngine first=ReminderEngine.get(context,configuration,store("encrypted-test-domain"));
  assertSame(first,ReminderEngine.get(context,configuration(id),store("encrypted-test-domain")));
  try{ReminderEngine.get(context,configuration,store("different-domain"));fail("Changed secure storage identity admitted");}catch(IllegalStateException expected){}
  assertNotSame(first,ReminderEngine.get(context,configuration(id+"_other"),store("encrypted-test-domain")));
 }
}
