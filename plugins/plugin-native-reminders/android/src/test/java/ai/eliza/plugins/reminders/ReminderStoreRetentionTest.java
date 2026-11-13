package ai.eliza.plugins.reminders;

import android.app.Activity;
import android.content.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.util.*;
import static org.junit.Assert.*;

/** Operation receipt retention on one synthetic no-alert reminder; no provider or model. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28,manifest=Config.NONE)
public class ReminderStoreRetentionTest {
 static final String HASH=new String(new char[64]).replace('\0','a');
 static final class Memory implements SecureStringStore {
  final String name;final Map<String,String> slots=new HashMap<>();
  Memory(String name){this.name=name;}
  public String identity(){return name;}
  public String read(String key){return slots.get(key);}
  public void write(String key,String value){slots.put(key,value);}
 }
 private static JSONObject create(long due)throws Exception{return new JSONObject().put("type","reminder_create").put("fields",new JSONObject().put("title","Synthetic task").put("body","Owned fixture").put("schedule",new JSONObject().put("at",due).put("dueAt",due).put("alertMinutes",JSONObject.NULL).put("recurrence",JSONObject.NULL)));}
 private static JSONObject edit(ReminderEngine engine,int i)throws Exception{return new JSONObject().put("type","reminder_update").put("target",engine.selected("create")).put("fields",new JSONObject().put("title","Synthetic task "+i).put("body","Owned fixture"));}
 private static SharedPreferences envelope(Context context,ReminderConfiguration config){return context.getSharedPreferences(config.envelopeName,Context.MODE_PRIVATE);}
 private static JSONObject receipts(Context context,ReminderConfiguration config)throws Exception{return new JSONObject(envelope(context,config).getString("envelope",null)).getJSONObject("operations");}
 private static void rewrite(Context context,ReminderConfiguration config,String phase,String withoutSeq)throws Exception{
  JSONObject value=new JSONObject(envelope(context,config).getString("envelope",null)),operations=value.getJSONObject("operations");
  for(Iterator<String> it=operations.keys();it.hasNext();){String key=it.next();if(phase!=null)operations.getJSONObject(key).put("phase",phase);if(key.equals(withoutSeq))operations.getJSONObject(key).remove("seq");}
  assertTrue(envelope(context,config).edit().putString("envelope",value.toString()).commit());
 }

 @Test public void settledReceiptsRetireOldestFirstAndUncertainOnesNeverDo()throws Exception{
  Context context=RuntimeEnvironment.getApplication();String name="retention"+UUID.randomUUID().toString().replace("-","");
  ReminderConfiguration config=ReminderQuestionTest.configuration(name,false);ReminderEngine engine=ReminderEngine.get(context,config,c->new Memory(name));
  long due=System.currentTimeMillis()+86400000L;
  assertEquals("succeeded",engine.operate("create",HASH,create(due)).getString("status"));
  for(int i=1;i<ReminderStore.MAX_OPERATIONS+1;i++)assertEquals("succeeded",engine.operate("edit-"+i,HASH,edit(engine,i)).getString("status"));
  JSONObject saved=receipts(context,config);
  assertEquals(ReminderStore.MAX_OPERATIONS,saved.length());assertFalse(saved.has("create"));assertTrue(saved.has("edit-1"));assertTrue(saved.has("edit-"+ReminderStore.MAX_OPERATIONS));
  assertEquals("unknown",engine.operationReceipt("create",HASH,create(due)).getString("status"));
  // A retired creation is never replayed: its reminder still owns the id.
  try{engine.operate("create",HASH,create(due));fail("Retired creation replayed");}catch(IllegalArgumentException expected){}

  // A read changes nothing and keeps no receipt.
  JSONObject read=new JSONObject().put("type","reminder_read_selected").put("target",engine.selected("create"));
  assertEquals("succeeded",engine.operate("read-1",HASH,read).getString("status"));
  assertFalse(receipts(context,config).has("read-1"));
  assertEquals(ReminderStore.MAX_OPERATIONS,receipts(context,config).length());

  // A legacy receipt without seq is retired before any sequenced one.
  String last="edit-"+ReminderStore.MAX_OPERATIONS;
  rewrite(context,config,null,last);
  engine.operate("edit-legacy",HASH,edit(engine,0));
  saved=receipts(context,config);assertFalse(saved.has(last));assertTrue(saved.has("edit-1"));assertTrue(saved.has("edit-legacy"));

  // When every receipt is still uncertain the ledger refuses and nothing changes.
  rewrite(context,config,"effects-uncertain",null);String before=envelope(context,config).getString("envelope",null);
  try{engine.operate("edit-full",HASH,edit(engine,-1));fail("Uncertain receipt evicted");}catch(ReminderStore.OperationsFull expected){}
  assertEquals(before,envelope(context,config).getString("envelope",null));
 }
}
