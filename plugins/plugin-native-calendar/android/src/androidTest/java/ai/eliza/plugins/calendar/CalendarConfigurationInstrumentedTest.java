package ai.eliza.plugins.calendar;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Native host identity and journal isolation; does not access the user's calendar provider. */
@RunWith(AndroidJUnit4.class)
public final class CalendarConfigurationInstrumentedTest {
 private CalendarConfiguration configuration(String journal,String prefix){return new CalendarConfiguration("Test account","test-local","Test calendar",journal,prefix,0xff0000ff);}
 @Test public void rejectsAmbiguousHostIdentity(){
  for(String journal:new String[]{"", "../other", "bad/name"}){
   try{configuration(journal,"example://calendar-creation/");fail("Invalid journal admitted");}catch(IllegalArgumentException expected){}
  }
  for(String prefix:new String[]{"relative/", "example://calendar?query/", "example://calendar#fragment/", "example://calendar"}){
   try{configuration("test",prefix);fail("Invalid prefix admitted");}catch(IllegalArgumentException expected){}
  }
 }
 @Test public void instancesShareJournalIdentityButSeparateJournalsRemainIndependent()throws Exception{
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
  String journal="calendar_test_"+UUID.randomUUID().toString().replace("-","");
  CalendarConfiguration configuration=configuration(journal,"example://calendar-creation/");
  assertEquals(0,new CalendarCreationStore(configuration).pendingCreations(context).getJSONArray("creations").length());
  assertEquals(0,new CalendarCreationStore(configuration).pendingCreations(context).getJSONArray("creations").length());
  try{new CalendarCreationStore(configuration(journal,"other://calendar-creation/")).pendingCreations(context);fail("Changed journal identity admitted");}catch(IllegalStateException expected){}
  assertEquals(0,new CalendarCreationStore(configuration(journal+"_other","other://calendar-creation/")).pendingCreations(context).getJSONArray("creations").length());
 }
}
