package ai.eliza.plugins.calendar;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import java.util.*;

/** Executes the actual compiled host and shared bridge against an owned in-memory provider. */
public final class CalendarBridgeContract {
 static void require(boolean value,String why){if(!value)throw new AssertionError(why);}
 static final class Rows implements Cursor {
  final List<Object[]> rows;int at=-1;Rows(List<Object[]> rows){this.rows=rows;}
  public boolean moveToFirst(){at=0;return !rows.isEmpty();}public boolean moveToNext(){return ++at<rows.size();}public int getCount(){return rows.size();}public boolean isNull(int c){return rows.get(at)[c]==null;}public int getType(int c){return 1;}public long getLong(int c){return Long.parseLong(rows.get(at)[c].toString());}public int getInt(int c){return (int)getLong(c);}public String getString(int c){Object v=rows.get(at)[c];return v==null?null:v.toString();}public void close(){}
 }
 static final class Provider extends ContentResolver {
  int reads;volatile int inserts;boolean readback=true;java.util.concurrent.CountDownLatch ready,releasePreparation,dispatch,releaseDispatch;ContentValues created;String lastPrefix;int instances;
  public Cursor query(Uri uri,String[] fields,String where,String[] args,String order){
   reads++;List<Object[]> result=new ArrayList<>();String path=uri.toString();
   if(path.contains("instances")){for(int i=0;i<instances;i++)result.add(new Object[]{(long)i+100,1L,"Event "+i,"Body","Here",1000L+i,2000L+i,0,null});}
   else if(path.contains("calendars/")){if(ready!=null){ready.countDown();try{if(!releasePreparation.await(3,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("Preparation barrier timed out");if(Thread.currentThread().getName().equals("calendar-second")&&!dispatch.await(3,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("First writer did not enter dispatch");}catch(InterruptedException e){throw new AssertionError(e);}}result.add(new Object[]{500});}
   else if(path.endsWith("calendars")){if(fields.length==1)result.add(new Object[]{1L});else result.add(new Object[]{1L,"On this phone",500,"Owner","LOCAL"});}
   else if(created!=null&&readback){
    if(args!=null&&args.length==2&&args[1].equals(created.getAsString("customAppUri"))){Object[] row=new Object[fields.length];row[0]=7L;for(int i=1;i<fields.length;i++)row[i]=created.getAsString(fields[i]);result.add(row);}
    else if(path.endsWith("events/7")){result.add(new Object[]{created.getAsInteger("allDay"),created.getAsString("eventTimezone"),created.getAsString("rrule"),created.getAsString("duration")});}
   }
   return new Rows(result);
  }
  public Uri insert(Uri uri,ContentValues values){inserts++;if(dispatch!=null&&inserts==1){dispatch.countDown();try{if(!releaseDispatch.await(3,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("Dispatch barrier timed out");}catch(InterruptedException e){throw new AssertionError(e);}}created=new ContentValues(values);lastPrefix=values.getAsString("customAppUri");return Uri.parse("events/7");}
 }
 static final class Preferences implements SharedPreferences,SharedPreferences.Editor {
  int commits;final Map<String,String> values=new HashMap<>();public String getString(String key,String fallback){return values.getOrDefault(key,fallback);}public Editor edit(){return this;}public Editor putString(String key,String value){values.put(key,value);return this;}public boolean commit(){commits++;return true;}
 }
 static final class Host extends Context {
  final Provider provider=new Provider();final Map<String,Preferences> stores=new HashMap<>();final String name;Host(String name){this.name=name;}
  public ContentResolver getContentResolver(){return provider;}public String getPackageName(){return name;}public java.io.File getDataDir(){return new java.io.File("/fixture/"+name);}public SharedPreferences getSharedPreferences(String name,int mode){return stores.computeIfAbsent(name,k->new Preferences());}
 }
 static Map<String,Map<String,String>> snapshot(Host host){Map<String,Map<String,String>> result=new HashMap<>();host.stores.forEach((name,prefs)->{Map<String,String> value=new HashMap<>(prefs.values);value.put("commit-count",Integer.toString(prefs.commits));result.put(name,value);});return result;}
 static void dispatch(CalendarPlugin plugin,String method,PluginCall call)throws Exception{plugin.getClass().getMethod(method,PluginCall.class).invoke(plugin,call);}
 static PluginCall call(JSObject data){return new PluginCall(data);}
 static void status(PluginCall call,String status){require(call.error==null,"Unexpected rejection: "+call.error);require(call.result!=null&&status.equals(call.result.optString("status")),"Expected "+status+", got "+call.result);}
 public static void main(String[] args)throws Exception{
  String className=args[0],journal=args[1],prefix=args[2];Host host=new Host(className);Plugin.context=host;
  CalendarPlugin plugin=(CalendarPlugin)Class.forName(className).getConstructor().newInstance();
  Plugin.permission=com.getcapacitor.PermissionState.DENIED;
  PluginCall denied=call(new JSObject().put("begin",0).put("end",100));plugin.list(denied);status(denied,"permission-required");require(host.provider.reads==0,"Denied list reached provider");
  PluginCall deniedOptions=call(new JSObject());dispatch(plugin,"saveOptions",deniedOptions);status(deniedOptions,"permission-required");require(host.provider.inserts==0,"Denied options wrote");
  Plugin.permission=com.getcapacitor.PermissionState.GRANTED;host.provider.instances=2001;
  PluginCall list=call(new JSObject().put("begin",0).put("end",100));plugin.list(list);status(list,"ready");require(list.result.getBoolean("truncated")&&list.result.getJSONArray("events").length()==2000,"Host bound not applied");
  PluginCall invalid=call(new JSObject().put("begin",100).put("end",100));int before=host.provider.reads;plugin.list(invalid);require(invalid.error!=null&&host.provider.reads==before,"Invalid range reached provider");
  JSObject event=new JSObject().put("title","Owned fixture").put("begin",86400000L).put("end",172800000L).put("allDay",true).put("timeZone","UTC").put("rrule","FREQ=DAILY;COUNT=2");
  String id="afc732b3-416e-4dd3-98ce-0bd854106c46";
  host.provider.readback=false;PluginCall save=call(new JSObject().put("event",event).put("calendarId","1").put("creationId",id));dispatch(plugin,"saveOptions",save);status(save,"unknown");require(host.provider.inserts==1,"One dispatched creation");require(host.provider.lastPrefix.equals(prefix+"options/"+id),"Installed option URI changed");require(host.stores.containsKey(journal+"-options"),"Installed options journal changed");
  Map<String,Map<String,String>> beforeCross=snapshot(host);
  PluginCall crossTimed=call(new JSObject().put("title","Different timed event").put("begin",1000L).put("end",2000L).put("calendarId","1").put("creationId",id).put("separateCreation",true));plugin.save(crossTimed);require(crossTimed.error!=null&&host.provider.inserts==1,"An option identity was reused for a timed creation");require(beforeCross.equals(snapshot(host)),"Refused timed collision rewrote a journal");
  PluginCall retry=call(save.data);dispatch(plugin,"saveOptions",retry);status(retry,"unknown");require(host.provider.inserts==1,"Unknown creation replayed");
  PluginCall blockedAck=call(new JSObject().put("creationId",id));plugin.acknowledgeCreation(blockedAck);require(blockedAck.error!=null,"Unconfirmed creation acknowledged");
  host.provider.readback=true;PluginCall pending=call(new JSObject());plugin.pendingCreations(pending);status(pending,"ready");require(pending.result.getJSONArray("creations").getJSONObject(0).getString("status").equals("saved"),"Options readback missing from merged journal");
  PluginCall options=call(new JSObject().put("id","7"));dispatch(plugin,"readOptions",options);status(options,"ready");require(options.result.getBoolean("allDay")&&options.result.getString("rrule").equals("FREQ=DAILY;COUNT=2"),"Option fields lost");
  PluginCall ack=call(new JSObject().put("creationId",id));plugin.acknowledgeCreation(ack);status(ack,"acknowledged");PluginCall empty=call(new JSObject());plugin.pendingCreations(empty);require(empty.result.getJSONArray("creations").length()==0,"Acknowledged option receipt retained");
  String timedId="afc732b3-416e-4dd3-98ce-0bd854106c47";host.provider.readback=false;
  PluginCall timed=call(new JSObject().put("title","Timed event").put("begin",1000L).put("end",2000L).put("calendarId","1").put("creationId",timedId));plugin.save(timed);status(timed,"unknown");int writes=host.provider.inserts;
  beforeCross=snapshot(host);
  PluginCall crossOptions=call(new JSObject().put("event",event).put("calendarId","1").put("creationId",timedId).put("separateCreation",true));dispatch(plugin,"saveOptions",crossOptions);require(crossOptions.error!=null&&host.provider.inserts==writes,"A timed identity was reused for an option creation");require(beforeCross.equals(snapshot(host)),"Refused option collision rewrote a journal");
  // Seed a legacy collision through the old journal helpers. The new bridge must not choose one.
  java.lang.reflect.Field configuration=CalendarPlugin.class.getDeclaredField("configuration");configuration.setAccessible(true);CalendarConfiguration config=(CalendarConfiguration)configuration.get(plugin);
  String legacyId="afc732b3-416e-4dd3-98ce-0bd854106c48";ContentValues legacy=ai.eliza.plugins.calendar.write.CalendarEventOptions.parse(event).values(1L);host.provider.readback=true;
  new CalendarCreationStore(config).create(host,legacyId,legacy,true);new ai.eliza.plugins.calendar.write.CalendarOptionCreationStore(config).create(host,legacyId,legacy,true);
  Map<String,Map<String,String>> legacyBefore=snapshot(host);
  PluginCall legacyAck=call(new JSObject().put("creationId",legacyId));plugin.acknowledgeCreation(legacyAck);require(legacyAck.error!=null,"Legacy cross-journal collision was silently acknowledged");require(legacyBefore.equals(snapshot(host)),"Legacy collision acknowledgement changed receipt bytes");
  PluginCall legacyPending=call(new JSObject());plugin.pendingCreations(legacyPending);int duplicates=0;org.json.JSONArray receipts=legacyPending.result.getJSONArray("creations");for(int i=0;i<receipts.length();i++)if(legacyId.equals(receipts.getJSONObject(i).getString("creationId")))duplicates++;require(duplicates==2,"A colliding legacy receipt was erased");
  for(boolean optionWrite:new boolean[]{true,false}){
   String other=optionWrite?journal:journal+"-options",prior=host.stores.get(other).values.get("operations");host.stores.get(other).values.put("operations","{unreadable");
   Map<String,Map<String,String>> damaged=snapshot(host);int effects=host.provider.inserts;String fresh=optionWrite?"afc732b3-416e-4dd3-98ce-0bd854106c49":"afc732b3-416e-4dd3-98ce-0bd854106c50";
   PluginCall refused=call(new JSObject().put("title","Refused").put("begin",1000L).put("end",2000L).put("event",event).put("calendarId","1").put("creationId",fresh));if(optionWrite)dispatch(plugin,"saveOptions",refused);else plugin.save(refused);
   require(refused.error!=null&&host.provider.inserts==effects,"Unreadable other store admitted a write");require(damaged.equals(snapshot(host)),"Unreadable other store was rewritten");host.stores.get(other).values.put("operations",prior);
  }
  int beforeHandoff=host.provider.inserts;
  Plugin.activity.focused=false;PluginCall hidden=call(new JSObject().put("event",event));dispatch(plugin,"insertHandoff",hidden);status(hidden,"unavailable");require(Plugin.activity.launches==0,"Background opened editor");
  Plugin.activity.focused=true;android.content.pm.PackageManager.editor=host.getPackageName();PluginCall self=call(new JSObject().put("event",event));dispatch(plugin,"insertHandoff",self);status(self,"unavailable");require(Plugin.activity.launches==0,"Self editor loop");
  android.content.pm.PackageManager.editor="external.calendar";event.put("alerts",new org.json.JSONArray().put(10));PluginCall handoff=call(new JSObject().put("event",event));dispatch(plugin,"insertHandoff",handoff);status(handoff,"opened");require(!handoff.result.getBoolean("alertsPrefilled")&&Plugin.activity.launches==1&&host.provider.inserts==beforeHandoff,"Handoff claimed save or inserted");
  require(plugin.getClass().getMethod("saveOptions",PluginCall.class).getDeclaringClass()==CalendarPlugin.class,"Host still owns duplicate option behavior");
  event.remove("alerts");
  Host racing=new Host(className+"-race");Plugin.context=racing;racing.provider.readback=false;
  racing.provider.ready=new java.util.concurrent.CountDownLatch(2);racing.provider.releasePreparation=new java.util.concurrent.CountDownLatch(1);racing.provider.dispatch=new java.util.concurrent.CountDownLatch(1);racing.provider.releaseDispatch=new java.util.concurrent.CountDownLatch(1);
  CalendarPlugin first=(CalendarPlugin)Class.forName(className).getConstructor().newInstance(),second=(CalendarPlugin)Class.forName(className).getConstructor().newInstance();
  String racingId="afc732b3-416e-4dd3-98ce-0bd854106c51";
  PluginCall left=call(new JSObject().put("event",event).put("calendarId","1").put("creationId",racingId).put("separateCreation",true)),right=call(new JSObject().put("title","Timed race").put("begin",1000L).put("end",2000L).put("calendarId","1").put("creationId",racingId).put("separateCreation",true));
  java.util.concurrent.atomic.AtomicReference<Throwable> fault=new java.util.concurrent.atomic.AtomicReference<>();
  Thread one=new Thread(()->{try{dispatch(first,"saveOptions",left);}catch(Throwable e){fault.set(e);}},"calendar-first"),two=new Thread(()->{try{second.save(right);}catch(Throwable e){fault.set(e);}},"calendar-second");one.start();two.start();
  require(racing.provider.ready.await(3,java.util.concurrent.TimeUnit.SECONDS),"Both instance prechecks reached the same destination");racing.provider.releasePreparation.countDown();
  require(racing.provider.dispatch.await(3,java.util.concurrent.TimeUnit.SECONDS),"First shared store dispatched");
  long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(2);while(one.getState()!=Thread.State.BLOCKED&&two.getState()!=Thread.State.BLOCKED&&one.isAlive()&&two.isAlive()&&System.nanoTime()<deadline)Thread.yield();
  require(one.getState()==Thread.State.BLOCKED||two.getState()==Thread.State.BLOCKED,"Opposite store waits on the existing canonical journal guard");require(racing.provider.inserts==1,"Opposite journal dispatched while the first was held");
  racing.provider.releaseDispatch.countDown();one.join(3000);two.join(3000);require(!one.isAlive()&&!two.isAlive()&&fault.get()==null,"Both race callers completed");require(racing.provider.inserts==1,"Cross-journal race created two events");require((left.error!=null) != (right.error!=null),"Exactly one cross-journal caller was refused");
  System.out.println("PASS actual "+className+": denied/bounded list, option unknown/recovery/ack, exact namespace, cross-journal collision/corruption/no-rewrite and two-instance race, foreground external handoff");
 }
}
