package ai.eliza.plugins.calendar;

import android.Manifest;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.ContentProviderOperation;
import java.util.ArrayList;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.TimeZone;

/** CalendarProvider owns accounts, events and recurrence. No synthetic agenda. */
public abstract class CalendarPlugin extends Plugin {
 private final CalendarConfiguration configuration;
 private final CalendarCreationStore creations;
 protected CalendarPlugin(CalendarConfiguration configuration){this.configuration=java.util.Objects.requireNonNull(configuration);this.creations=new CalendarCreationStore(configuration);}

 private boolean allowed(){return getPermissionState("calendar")==PermissionState.GRANTED;}
 private JSObject statusValue(String status){JSObject v=new JSObject();v.put("status",status);return v;}
 private void status(PluginCall c,String status){c.resolve(statusValue(status));}
 @PluginMethod public void requestAccess(PluginCall c){if(allowed())status(c,"granted");else requestPermissionForAlias("calendar",c,"permissionResult");}
 @PermissionCallback private void permissionResult(PluginCall c){status(c,allowed()?"granted":"denied");}
 @PluginMethod public void list(PluginCall c){
  if(!allowed()){status(c,"permission-required");return;}
  Long begin=c.getLong("begin"),end=c.getLong("end");
  if(begin==null||end==null||begin<0||end<=begin||end-begin>370L*86400000){c.reject("A valid calendar range of at most 370 days is required");return;}
  try{
   ai.eliza.plugins.calendar.read.CalendarReadAccess reader=new ai.eliza.plugins.calendar.read.CalendarReadAccess(getContext().getContentResolver());
   JSObject value=new JSObject();value.put("status","ready");value.put("calendars",reader.calendars());value.put("events",reader.events(begin,end));value.put("truncated",false);c.resolve(value);
  }catch(Exception e){c.reject("Calendar provider could not be read");}
 }
 private boolean workflowReadAllowed(){return androidx.core.content.ContextCompat.checkSelfPermission(getContext(),Manifest.permission.READ_CALENDAR)==android.content.pm.PackageManager.PERMISSION_GRANTED;}
 private boolean workflowForeground(){return getActivity()!=null&&!getActivity().isFinishing()&&!getActivity().isDestroyed()&&getActivity().hasWindowFocus();}
 @PluginMethod public void requestWorkflowReadAccess(PluginCall c){if(workflowReadAllowed())status(c,"granted");else requestPermissionForAlias("workflowCalendarRead",c,"workflowPermissionResult");}
 @PermissionCallback private void workflowPermissionResult(PluginCall c){status(c,workflowReadAllowed()?"granted":"denied");}
 @PluginMethod public void workflowCalendars(PluginCall c){
  if(!workflowReadAllowed()){status(c,"permission-required");return;}if(!workflowForeground()){c.reject("Open Workflows before reading calendar sources");return;}
  try{JSArray calendars=new JSArray();try(Cursor rows=getContext().getContentResolver().query(CalendarContract.Calendars.CONTENT_URI,new String[]{CalendarContract.Calendars._ID,CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,CalendarContract.Calendars.ACCOUNT_NAME},null,null,CalendarContract.Calendars._ID+" ASC")){if(rows==null)throw new IllegalStateException();while(rows.moveToNext()){if(calendars.length()>=256)throw new IllegalStateException();JSObject row=new JSObject();row.put("id",Long.toString(rows.getLong(0)));row.put("name",rows.getString(1)==null?"":rows.getString(1));org.json.JSONObject identity=ai.eliza.plugins.calendar.read.CalendarSourceIdentity.read(getContext().getContentResolver(),rows.getLong(0));row.put("account",identity.getString("account"));row.put("sourceRevision",identity.getString("sourceRevision"));calendars.put(row);}}
   if(!workflowForeground()||!workflowReadAllowed())throw new IllegalStateException();JSObject value=new JSObject();value.put("status","ready");value.put("calendars",calendars);c.resolve(value);
  }catch(Exception unavailable){c.reject("Selected calendar sources could not be read");}
 }
 @PluginMethod public void readWorkflowRange(PluginCall c){
  if(!workflowReadAllowed()){status(c,"permission-required");return;}if(!workflowForeground()){c.reject("Workflow calendar read requires the foreground phone");return;}
  try{
   org.json.JSONArray events=ai.eliza.plugins.calendar.read.SelectedCalendarReader.read(getContext().getContentResolver(),c.getArray("calendarIds"),c.getString("start"),c.getString("end"),c.getInt("maximumEvents"));
   if(!workflowReadAllowed()||!workflowForeground())throw new IllegalStateException();JSObject value=new JSObject();value.put("status","ready");value.put("events",events);c.resolve(value);
  }catch(Exception unavailable){c.reject("Calendar read was not completed within the approved scope. Nothing was uploaded.");}
 }
 @PluginMethod public void open(PluginCall c){
  try {
   long id=Long.parseLong(c.getString("id",""));
   if(id<=0)throw new IllegalArgumentException();
   android.content.Intent intent=new android.content.Intent(android.content.Intent.ACTION_VIEW,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,id));
   Long begin=c.getLong("begin"),end=c.getLong("end");
   if(begin!=null)intent.putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME,begin);
   if(end!=null)intent.putExtra(CalendarContract.EXTRA_EVENT_END_TIME,end);
   getActivity().startActivity(intent);status(c,"opened");
  }catch(Exception e){c.reject("Android Calendar could not open this event");}
 }
 private android.app.AlertDialog deleteDialog;
 private volatile String activeAgentOperation;
 private final java.util.concurrent.atomic.AtomicBoolean deleting=new java.util.concurrent.atomic.AtomicBoolean();
 private boolean unlocked(){android.app.KeyguardManager keyguard=(android.app.KeyguardManager)getContext().getSystemService(android.content.Context.KEYGUARD_SERVICE);return keyguard!=null&&!keyguard.isDeviceLocked();}
 /** Capture an exact provider revision only after checking the row the user selected. */
 @PluginMethod public void inspect(PluginCall c){
  if(!allowed()){status(c,"permission-required");return;}if(!workflowForeground()||!unlocked()){status(c,"unavailable");return;}
  try{CalendarEventGuard.Snapshot snapshot=CalendarEventGuard.read(getContext().getContentResolver(),Long.parseLong(c.getString("id","")),Long.parseLong(c.getString("calendarId","")));
   if(snapshot==null||!snapshot.visible(c.getObject("expected"))){status(c,"conflict");return;}
   if(!snapshot.direct(configuration.accountName,configuration.localCalendarName)){status(c,"external");return;}
   JSObject value=new JSObject();value.put("status","ready");value.put("revision",snapshot.revision);value.put("sourceRevision",snapshot.sourceRevision);c.resolve(value);
  }catch(Exception unavailable){status(c,"unavailable");}
 }
 /** Always asks native confirmation; callers cannot pass a flag that bypasses review. */
 @PluginMethod public void remove(PluginCall c){
  if(!allowed()){status(c,"permission-required");return;}if(!workflowForeground()||!unlocked()){status(c,"unavailable");return;}
  if(!deleting.compareAndSet(false,true)){status(c,"busy");return;}
  try{
   final CalendarEventGuard.Snapshot snapshot=CalendarEventGuard.read(getContext().getContentResolver(),Long.parseLong(c.getString("id","")),Long.parseLong(c.getString("calendarId","")));
   if(snapshot==null||!snapshot.visible(c.getObject("expected"))||!snapshot.revision.equals(c.getString("revision",""))){deleting.set(false);status(c,"conflict");return;}
   if(!snapshot.direct(configuration.accountName,configuration.localCalendarName)){deleting.set(false);status(c,"external");return;}
   getActivity().runOnUiThread(()->{
    // Publish only after dismissal releases the shared gate. Keep provider outcome even on cancellation.
    final java.util.concurrent.atomic.AtomicBoolean delivered=new java.util.concurrent.atomic.AtomicBoolean();
    final android.app.AlertDialog[] ownedDialog={null};final boolean[] resolved={false};final JSObject[] outcome={null};
    try{
    if(!workflowForeground()||!allowed()||!unlocked()){deleting.set(false);status(c,"unavailable");return;}
    String title=snapshot.event.getAsString("title"),zone=snapshot.event.getAsString("eventTimezone");
    String message=(title==null?"Untitled event":title)+"\n"+configuration.displayName+"\n"+eventTimeDescription(snapshot.event.getAsLong("dtstart"),snapshot.event.getAsLong("dtend"),zone)+"\n\nDelete this one local event? This cannot be undone.";
    deleteDialog=new android.app.AlertDialog.Builder(getActivity()).setTitle("Delete calendar event?").setMessage(message).setNegativeButton("Cancel",(dialog,which)->{}).setPositiveButton("Delete event",(dialog,which)->{
     resolved[0]=true;
     if(!allowed()||!unlocked()){outcome[0]=statusValue("permission-required");return;}
     try{
      ArrayList<ContentProviderOperation> operations=snapshot.assertions();operations.add(ContentProviderOperation.newDelete(CalendarContract.Events.CONTENT_URI).withSelection(CalendarContract.Events._ID+"=?",new String[]{Long.toString(snapshot.id)}).withExpectedCount(1).build());
      getContext().getContentResolver().applyBatch(CalendarContract.AUTHORITY,operations);
      try(Cursor row=getContext().getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,snapshot.id),new String[]{CalendarContract.Events.DELETED},null,null,null)){if(row==null||row.moveToFirst()&&row.getInt(0)==0)throw new IllegalStateException("Deletion readback unavailable");}
      JSObject value=new JSObject();value.put("status","deleted");value.put("id",Long.toString(snapshot.id));value.put("calendarId",Long.toString(snapshot.calendarId));value.put("revision",snapshot.revision);outcome[0]=value;
     }catch(android.content.OperationApplicationException conflict){outcome[0]=statusValue("conflict");}catch(Exception uncertain){outcome[0]=statusValue("unknown");}
    }).create();
    ownedDialog[0]=deleteDialog;deleteDialog.setOnDismissListener(dialog->{if(deleteDialog==ownedDialog[0]){deleteDialog=null;deleting.set(false);}if(delivered.compareAndSet(false,true))c.resolve(outcome[0]!=null?outcome[0]:statusValue(resolved[0]?"unknown":"cancelled"));});deleteDialog.show();
    }catch(Exception unavailable){if(deleteDialog==ownedDialog[0]){deleteDialog=null;deleting.set(false);}if(delivered.compareAndSet(false,true))c.resolve(outcome[0]!=null?outcome[0]:statusValue("unavailable"));}
   });
  }catch(Exception unavailable){deleting.set(false);status(c,"unavailable");}
 }
 @Override protected void handleOnPause(){super.handleOnPause();if(deleteDialog!=null)deleteDialog.dismiss();}
 @Override protected void handleOnDestroy(){if(deleteDialog!=null)deleteDialog.dismiss();super.handleOnDestroy();}
 /** Explicit New Event source initialization; no event is created. */
 @PluginMethod public void prepareAgentSource(PluginCall c){
  if(!allowed()){status(c,"permission-required");return;}if(!workflowForeground()||!unlocked()){status(c,"unavailable");return;}
  try{long id=localCalendar();JSObject value=new JSObject();value.put("status","ready");value.put("sourceId",Long.toString(id));value.put("sourceRevision",CalendarEventGuard.sourceRevision(getContext().getContentResolver(),id,configuration.accountName,configuration.localCalendarName));c.resolve(value);}catch(Exception failure){status(c,"unavailable");}
 }
 private static String eventTimeDescription(long start,long end,String timeZone){
  String zone=timeZone==null||timeZone.isEmpty()?"UTC":timeZone;
  String pattern="EEE, MMM d yyyy h:mm"+(start%60000!=0||end%60000!=0?":ss":"")+(start%1000!=0||end%1000!=0?".SSS":"")+" a z";
  java.text.DateFormat format=new java.text.SimpleDateFormat(pattern,java.util.Locale.getDefault());format.setTimeZone(TimeZone.getTimeZone(java.time.ZoneId.of(zone)));
  return format.format(new java.util.Date(start))+" — "+format.format(new java.util.Date(end))+"\nTime zone: "+zone;
 }
 private static void agentKeys(org.json.JSONObject value,String... keys)throws Exception{if(value==null||value.length()!=keys.length)throw new IllegalArgumentException();for(String key:keys)if(!value.has(key))throw new IllegalArgumentException();}
 private static String agentText(org.json.JSONObject value,String key,int maximum,boolean empty)throws Exception{Object raw=value.get(key);if(!(raw instanceof String))throw new IllegalArgumentException();String text=(String)raw;if(text.length()>maximum||(!empty&&text.trim().isEmpty())||text.indexOf(0)>=0)throw new IllegalArgumentException();return text;}
 private static long agentInstant(org.json.JSONObject value,String key)throws Exception{String text=agentText(value,key,24,false);long at=java.time.Instant.parse(text).toEpochMilli();String canonical=new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(java.time.Instant.ofEpochMilli(at));if(!text.equals(canonical)||at<0)throw new IllegalArgumentException();return at;}
 private static org.json.JSONObject agentFields(CalendarEventGuard.Snapshot snapshot)throws Exception{return new org.json.JSONObject().put("title",snapshot.event.getAsString("title")).put("description",snapshot.event.getAsString("description")==null?"":snapshot.event.getAsString("description")).put("location",snapshot.event.getAsString("eventLocation")==null?"":snapshot.event.getAsString("eventLocation")).put("start",new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(java.time.Instant.ofEpochMilli(snapshot.event.getAsLong("dtstart")))).put("end",new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(java.time.Instant.ofEpochMilli(snapshot.event.getAsLong("dtend")))).put("timeZone",snapshot.event.getAsString("eventTimezone"));}
 @PluginMethod public void cancelAgent(PluginCall c){String id=c.getString("operationId","");getActivity().runOnUiThread(()->{if(id.equals(activeAgentOperation)){activeAgentOperation=null;if(deleteDialog!=null)deleteDialog.dismiss();}status(c,"cancelled");});}
 private static boolean sameAgentFields(org.json.JSONObject a,org.json.JSONObject b){for(String key:new String[]{"title","description","location","start","end","timeZone"})if(!a.optString(key).equals(b.optString(key)))return false;return true;}
 /** Same native provider boundary for reviewed agent operations. No caller flag bypasses confirmation. */
 @PluginMethod public void executeAgent(PluginCall c){
  if(!allowed()){status(c,"permission-required");return;}if(!workflowForeground()||!unlocked()){status(c,"unavailable");return;}
  if(!deleting.compareAndSet(false,true)){status(c,"busy");return;}
  try{
   final String operationId=c.getString("operationId","");if(!operationId.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException();activeAgentOperation=operationId;
   final JSObject operation=c.getObject("operation");final String kind=agentText(operation,"type",40,false);final boolean create="calendar_create".equals(kind),read="calendar_read_selected".equals(kind),update="calendar_update".equals(kind),remove="calendar_delete".equals(kind);
   if(!create&&!read&&!update&&!remove)throw new IllegalArgumentException();agentKeys(operation,create?new String[]{"type","source","fields"}:update?new String[]{"type","target","fields"}:new String[]{"type","target"});
   final org.json.JSONObject target=operation.getJSONObject(create?"source":"target");agentKeys(target,create?new String[]{"sourceId","sourceRevision"}:new String[]{"sourceId","sourceRevision","eventId","revision"});
   final long sourceId=Long.parseLong(agentText(target,"sourceId",128,false));final String sourceRevision=agentText(target,"sourceRevision",64,false);if(!sourceRevision.matches("[a-f0-9]{64}"))throw new IllegalArgumentException();
   if(!sourceRevision.equals(CalendarEventGuard.sourceRevision(getContext().getContentResolver(),sourceId,configuration.accountName,configuration.localCalendarName)))throw new IllegalStateException("Source changed");
   final CalendarEventGuard.Snapshot snapshot=create?null:CalendarEventGuard.read(getContext().getContentResolver(),Long.parseLong(agentText(target,"eventId",128,false)),sourceId);
   if(!create&&(snapshot==null||!snapshot.direct(configuration.accountName,configuration.localCalendarName)||!snapshot.revision.equals(agentText(target,"revision",64,false))||!snapshot.sourceRevision.equals(sourceRevision)))throw new IllegalStateException("Event changed");
   final ContentValues changed=new ContentValues();final org.json.JSONObject fields=create||update?operation.getJSONObject("fields"):null;
   if(fields!=null){agentKeys(fields,"title","description","location","start","end","timeZone");long begin=agentInstant(fields,"start"),end=agentInstant(fields,"end");if(end<=begin||end-begin>370L*86400000)throw new IllegalArgumentException();String zone=agentText(fields,"timeZone",128,false);java.time.ZoneId.of(zone);if(update&&!zone.equals(snapshot.event.getAsString("eventTimezone")))throw new IllegalArgumentException("Timezone change requires separate review");changed.put(CalendarContract.Events.TITLE,agentText(fields,"title",500,false));changed.put(CalendarContract.Events.DESCRIPTION,agentText(fields,"description",16000,true));changed.put(CalendarContract.Events.EVENT_LOCATION,agentText(fields,"location",2000,true));changed.put(CalendarContract.Events.DTSTART,begin);changed.put(CalendarContract.Events.DTEND,end);changed.put(CalendarContract.Events.EVENT_TIMEZONE,zone);changed.put(CalendarContract.Events.CALENDAR_ID,sourceId);}
   final org.json.JSONObject reviewed=fields==null?agentFields(snapshot):fields;
   getActivity().runOnUiThread(()->{final java.util.concurrent.atomic.AtomicBoolean delivered=new java.util.concurrent.atomic.AtomicBoolean();final android.app.AlertDialog[] ownedDialog={null};final boolean[] resolved={false};final JSObject[] outcome={null};try{
    if(!workflowForeground()||!allowed()||!unlocked()||!operationId.equals(activeAgentOperation)){activeAgentOperation=null;deleting.set(false);status(c,"unavailable");return;}
    String action=create?"Create":update?"Update":remove?"Delete":"Share selected";
    String message=configuration.displayName+"\n"+reviewed.optString("title")+"\n"+eventTimeDescription(agentInstant(reviewed,"start"),agentInstant(reviewed,"end"),reviewed.optString("timeZone"));
    String location=reviewed.optString("location"),description=reviewed.optString("description");
    if(!location.trim().isEmpty())message+="\nLocation: "+location;
    if(!description.trim().isEmpty())message+="\n\n"+description;
    message+=read?"\n\nShare this event with the connected agent?":remove?"\n\nDelete this event from this phone? This cannot be undone.":"\n\nSave this event on this phone?";
    android.widget.TextView text=new android.widget.TextView(getActivity());text.setText(message);text.setPadding(32,16,32,16);android.widget.ScrollView scroll=new android.widget.ScrollView(getActivity());scroll.addView(text);
    deleteDialog=new android.app.AlertDialog.Builder(getActivity()).setTitle(action+" calendar event?").setView(scroll).setNegativeButton("Cancel",(dialog,which)->{}).setPositiveButton(read?"Share with agent":action+" event",(dialog,which)->{
     resolved[0]=true;if(!allowed()||!unlocked()||!operationId.equals(activeAgentOperation)){outcome[0]=statusValue("permission-required");return;}
     boolean dispatched=false;
     try{
      if(!sourceRevision.equals(CalendarEventGuard.sourceRevision(getContext().getContentResolver(),sourceId,configuration.accountName,configuration.localCalendarName)))throw new IllegalStateException();
      if(!create){CalendarEventGuard.Snapshot latest=CalendarEventGuard.read(getContext().getContentResolver(),snapshot.id,sourceId);if(latest==null||!latest.revision.equals(snapshot.revision))throw new IllegalStateException();}
      long eventId=create?0:snapshot.id;CalendarEventGuard.Snapshot after=snapshot;
      if(!read){ArrayList<ContentProviderOperation> operations=create?new ArrayList<>():snapshot.assertions();if(create){operations.add(CalendarEventGuard.sourceAssertion(getContext().getContentResolver(),sourceId,sourceRevision));operations.add(ContentProviderOperation.newInsert(CalendarContract.Events.CONTENT_URI).withValues(changed).build());}else if(update)operations.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,eventId)).withValues(changed).withExpectedCount(1).build());else operations.add(ContentProviderOperation.newDelete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,eventId)).withExpectedCount(1).build());
       dispatched=true;android.content.ContentProviderResult[] result=getContext().getContentResolver().applyBatch(CalendarContract.AUTHORITY,operations);if(create)eventId=ContentUris.parseId(result[result.length-1].uri);
       after=CalendarEventGuard.read(getContext().getContentResolver(),eventId,sourceId);
       if(remove){if(after!=null&&after.event.getAsInteger("deleted")==0)throw new IllegalStateException();}else if(after==null||!after.direct(configuration.accountName,configuration.localCalendarName)||!sameAgentFields(agentFields(after),reviewed))throw new IllegalStateException();
      }
      JSObject value=new JSObject();value.put("status","applied");value.put("result",new org.json.JSONObject().put("version",1).put("kind",kind).put("sourceId",Long.toString(sourceId)).put("eventId",Long.toString(eventId)).put("revision",remove||read?snapshot.revision:after.revision));if(read)value.getJSONObject("result").put("fields",agentFields(snapshot));outcome[0]=value;
     }catch(android.content.OperationApplicationException conflict){outcome[0]=statusValue("conflict");}catch(Exception failure){outcome[0]=statusValue(dispatched?"unknown":"conflict");}
    }).create();ownedDialog[0]=deleteDialog;deleteDialog.setOnDismissListener(dialog->{if(deleteDialog==ownedDialog[0]){if(operationId.equals(activeAgentOperation))activeAgentOperation=null;deleteDialog=null;deleting.set(false);}if(delivered.compareAndSet(false,true))c.resolve(outcome[0]!=null?outcome[0]:statusValue(resolved[0]?"unknown":"cancelled"));});deleteDialog.show();
   }catch(Exception unavailable){if(deleteDialog==ownedDialog[0]){deleteDialog=null;deleting.set(false);}if(delivered.compareAndSet(false,true))c.resolve(outcome[0]!=null?outcome[0]:statusValue("unavailable"));}});
  }catch(Exception invalid){deleting.set(false);status(c,"conflict");}
 }
 private long localCalendar(){
  String where=CalendarContract.Calendars.ACCOUNT_NAME+"=? AND "+CalendarContract.Calendars.ACCOUNT_TYPE+"=? AND "+CalendarContract.Calendars.NAME+"=?";
  try(Cursor rows=getContext().getContentResolver().query(CalendarContract.Calendars.CONTENT_URI,new String[]{CalendarContract.Calendars._ID},where,new String[]{configuration.accountName,CalendarContract.ACCOUNT_TYPE_LOCAL,configuration.localCalendarName},null)){if(rows!=null&&rows.moveToFirst())return rows.getLong(0);}
  ContentValues v=new ContentValues();v.put(CalendarContract.Calendars.ACCOUNT_NAME,configuration.accountName);v.put(CalendarContract.Calendars.ACCOUNT_TYPE,CalendarContract.ACCOUNT_TYPE_LOCAL);v.put(CalendarContract.Calendars.NAME,configuration.localCalendarName);v.put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,configuration.displayName);v.put(CalendarContract.Calendars.CALENDAR_COLOR,configuration.color);v.put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,CalendarContract.Calendars.CAL_ACCESS_OWNER);v.put(CalendarContract.Calendars.OWNER_ACCOUNT,configuration.accountName);v.put(CalendarContract.Calendars.CALENDAR_TIME_ZONE,TimeZone.getDefault().getID());v.put(CalendarContract.Calendars.VISIBLE,1);v.put(CalendarContract.Calendars.SYNC_EVENTS,1);
  Uri uri=CalendarContract.Calendars.CONTENT_URI.buildUpon().appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER,"true").appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME,configuration.accountName).appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE,CalendarContract.ACCOUNT_TYPE_LOCAL).build();
  Uri inserted=getContext().getContentResolver().insert(uri,v);if(inserted==null)throw new IllegalStateException("Calendar insert returned no URI");return ContentUris.parseId(inserted);
 }
 private boolean writable(long id){try(Cursor row=getContext().getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,id),new String[]{CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL},null,null,null)){return row!=null&&row.moveToFirst()&&row.getInt(0)>=CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR;}}
 @PluginMethod public void pendingCreations(PluginCall c){
  if(!allowed()){status(c,"permission-required");return;}
  try{c.resolve(creations.pendingCreations(getContext()));}catch(Exception unavailable){c.reject("Calendar creation recovery unavailable. Nothing was retried.");}
 }
 @PluginMethod public void acknowledgeCreation(PluginCall c){
  if(!allowed()){status(c,"permission-required");return;}
  try{creations.acknowledge(getContext(),c.getString("creationId"));status(c,"acknowledged");}catch(Exception unavailable){c.reject("Calendar creation receipt could not be acknowledged.");}
 }
 @PluginMethod public synchronized void save(PluginCall c){
  if(!allowed()){status(c,"permission-required");return;}
  String title=c.getString("title",""),body=c.getString("body",""),location=c.getString("location",""),calendar=c.getString("calendarId","local"),id=c.getString("id","");
  Long begin=c.getLong("begin"),end=c.getLong("end");
  if(title.trim().isEmpty()||title.length()>500||body.length()>16000||location.length()>2000||begin==null||end==null||begin<0||end<=begin||end-begin>370L*86400000){c.reject("Invalid calendar event");return;}

  try{
   long calendarId=calendar.equals("local")?localCalendar():Long.parseLong(calendar);
   if(!writable(calendarId)){c.reject("Calendar is read-only");return;}
   ContentValues values=new ContentValues();values.put(CalendarContract.Events.TITLE,title.trim());values.put(CalendarContract.Events.DESCRIPTION,body);values.put(CalendarContract.Events.EVENT_LOCATION,location);values.put(CalendarContract.Events.DTSTART,begin);values.put(CalendarContract.Events.DTEND,end);values.put(CalendarContract.Events.EVENT_TIMEZONE,TimeZone.getDefault().getID());
   values.put(CalendarContract.Events.CALENDAR_ID,calendarId);
   Uri uri;
   if(id.isEmpty()){c.resolve(creations.create(getContext(),c.getString("creationId"),values,Boolean.TRUE.equals(c.getBoolean("separateCreation"))));return;}
   else {
    long eventId=Long.parseLong(id);if(eventId<=0)throw new IllegalArgumentException();
    JSObject expected=c.getObject("expected");
    if(expected==null){c.reject("Refresh the event before editing");return;}
    CalendarEventGuard.Snapshot snapshot=CalendarEventGuard.read(getContext().getContentResolver(),eventId,calendarId);
    if(snapshot==null||!snapshot.direct(configuration.accountName,configuration.localCalendarName)||!snapshot.visible(expected)||!snapshot.revision.equals(expected.getString("revision",""))){status(c,"conflict");return;}
    values.put(CalendarContract.Events.EVENT_TIMEZONE,snapshot.event.getAsString("eventTimezone"));
    ArrayList<ContentProviderOperation> operations=snapshot.assertions();
    uri=ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,eventId);
    operations.add(ContentProviderOperation.newUpdate(CalendarContract.Events.CONTENT_URI).withSelection(CalendarContract.Events._ID+"=?",new String[]{id}).withValues(values).withExpectedCount(1).build());
    try{getContext().getContentResolver().applyBatch(CalendarContract.AUTHORITY,operations);}
    catch(android.content.OperationApplicationException conflict){status(c,"conflict");return;}
   }
   if(uri==null)throw new IllegalStateException("No event URI");
   try(Cursor row=getContext().getContentResolver().query(uri,new String[]{CalendarContract.Events.TITLE,CalendarContract.Events.DTSTART,CalendarContract.Events.DTEND,CalendarContract.Events.DESCRIPTION,CalendarContract.Events.EVENT_LOCATION,CalendarContract.Events.CALENDAR_ID},null,null,null)){
    if(row==null||!row.moveToFirst()||!title.trim().equals(row.getString(0))||begin!=row.getLong(1)||end!=row.getLong(2)||!body.equals(row.getString(3))||!location.equals(row.getString(4))||calendarId!=row.getLong(5))throw new IllegalStateException("Readback mismatch");
   }
   JSObject value=new JSObject();value.put("status","saved");value.put("id",Long.toString(ContentUris.parseId(uri)));value.put("calendarId",Long.toString(calendarId));c.resolve(value);
  }catch(Exception e){c.reject("Calendar write could not be confirmed. Refresh before retrying.");}
 }
}
