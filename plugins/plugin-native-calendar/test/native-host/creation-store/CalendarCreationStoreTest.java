package ai.eliza.plugins.calendar;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import java.util.*;
import org.json.JSONObject;

/**
 * Runs the shared creation journal on the JVM against a stand-in provider: definite insert
 * failures, and the owner-driven exit for unknown creations. It is not Android CalendarProvider.
 */
public final class CalendarCreationStoreTest {
 static void require(boolean value,String why){if(!value)throw new AssertionError(why);}
 static void same(Object expected,Object actual,String why){if(!String.valueOf(expected).equals(String.valueOf(actual)))throw new AssertionError(why+"\n expected "+expected+"\n actual   "+actual);}
 static final class Rows implements Cursor {
  final List<Object[]> rows;int at=-1;Rows(List<Object[]> rows){this.rows=rows;}
  public boolean moveToFirst(){at=0;return !rows.isEmpty();}public boolean moveToNext(){return ++at<rows.size();}public int getCount(){return rows.size();}public boolean isNull(int c){return rows.get(at)[c]==null;}public int getType(int c){return 1;}public long getLong(int c){return Long.parseLong(rows.get(at)[c].toString());}public int getInt(int c){return (int)getLong(c);}public String getString(int c){Object v=rows.get(at)[c];return v==null?null:v.toString();}public void close(){}
 }
 /** insert: "row" stores and returns an id, "null" stores nothing and returns null, "lost" stores then throws, "throw" throws. */
 static final class Provider extends ContentResolver {
  String insert="row",query="ok";int inserts,queries;final Map<String,ContentValues> rows=new LinkedHashMap<>();
  public Uri insert(Uri uri,ContentValues values){
   inserts++;
   if(insert.equals("null"))return null;
   if(insert.equals("throw"))throw new IllegalStateException("Provider unavailable");
   rows.put(values.getAsString("customAppUri"),new ContentValues(values));
   if(insert.equals("lost"))throw new IllegalStateException("Binder response lost");
   return Uri.parse("events/"+(rows.size()+6));
  }
  public Cursor query(Uri uri,String[] fields,String where,String[] args,String order){
   queries++;
   if(query.equals("null"))return null;
   if(query.equals("throw"))throw new IllegalStateException("Provider unavailable");
   List<Object[]> result=new ArrayList<>();ContentValues row=rows.get(args[1]);
   if(row!=null){Object[] values=new Object[fields.length];values[0]=new ArrayList<>(rows.keySet()).indexOf(args[1])+7L;for(int i=1;i<fields.length;i++)values[i]=row.getAsString(fields[i]);result.add(values);}
   return new Rows(result);
  }
 }
 static final class Preferences implements SharedPreferences,SharedPreferences.Editor {
  final Map<String,String> values=new HashMap<>();public String getString(String key,String fallback){return values.getOrDefault(key,fallback);}public Editor edit(){return this;}public Editor putString(String key,String value){values.put(key,value);return this;}public boolean commit(){return true;}
 }
 static final class Host extends Context {
  final Provider provider=new Provider();final Map<String,Preferences> stores=new HashMap<>();final String name;Host(String name){this.name=name;}
  public ContentResolver getContentResolver(){return provider;}public String getPackageName(){return "owned.host";}public java.io.File getDataDir(){return new java.io.File("/fixture/"+name);}public SharedPreferences getSharedPreferences(String name,int mode){return stores.computeIfAbsent(name,k->new Preferences());}
 }
 static ContentValues event(String title){
  ContentValues values=new ContentValues();values.put("calendar_id",1L);values.put("title",title);values.put("description","");values.put("eventLocation","");values.put("dtstart",1000L);values.put("dtend",2000L);values.put("eventTimezone","UTC");return values;
 }
 static String id(int n){return String.format(Locale.ROOT,"afc732b3-416e-4dd3-98ce-0bd8541%05d",n);}
 static CalendarCreationStore store(){return new CalendarCreationStore("journal","host://creation/",null);}
 static void refused(java.util.concurrent.Callable<?> work,String why){try{work.call();}catch(Exception expected){return;}throw new AssertionError(why);}
 static String journal(Host host){return host.stores.get("journal").values.get("operations");}
 public static void main(String[] arguments)throws Exception{
  CalendarCreationStore store=store();

  Host failed=new Host("failed");failed.provider.insert="null";
  JSONObject definite=store.create(failed,id(1),event("Refused"),false);
  same("failed",definite.getString("status"),"A provider that returns no row is a definite failure");
  require(!store.hasPending(failed),"A failed creation does not block later saves");same(0,store.pendingCreationRows(failed).length(),"A failed creation needs no review");
  same("failed",store.create(failed,id(1),event("Refused"),false).getString("status"),"A retry of the same identity returns its receipt");same(1,failed.provider.inserts,"A failed creation is never retried");
  failed.provider.insert="row";same("saved",store.create(failed,id(2),event("Next"),false).getString("status"),"The next ordinary save proceeds");

  Host thrown=new Host("thrown");thrown.provider.insert="throw";
  same("unknown",store.create(thrown,id(3),event("Thrown"),false).getString("status"),"A thrown insert stays unknown");require(store.hasPending(thrown),"An unknown creation is pending");

  Host lost=new Host("lost");lost.provider.insert="lost";
  same("unknown",store.create(lost,id(4),event("Lost"),false).getString("status"),"A lost insert response is unknown");
  same("saved",store.dismiss(lost,id(4)),"Dismiss finds the provider row and settles it as saved");
  require(!store.hasPending(lost),"The saved row is acknowledged");same(0,store.pendingCreationRows(lost).length(),"No receipt is left to review");
  JSONObject receipt=store.create(lost,id(4),event("Lost"),false);same("saved",receipt.getString("status"),"The receipt names the saved event");same("7",receipt.getString("id"),"The provider row id is kept");same(1,lost.provider.inserts,"Dismissal never inserts");

  Host absent=new Host("absent");absent.provider.insert="throw";
  store.create(absent,id(5),event("Absent"),false);absent.provider.insert="row";
  same("pending-creation",store.create(absent,id(6),event("Blocked"),false).getString("status"),"An unknown creation blocks ordinary saves");
  same("dismissed",store.dismiss(absent,id(5)),"No provider row: the owner dismisses it");same(1,absent.provider.inserts,"Dismissal never retries the insert");
  require(!store.hasPending(absent),"A dismissed creation is not pending");
  same("dismissed",store.create(absent,id(5),event("Absent"),false).getString("status"),"A late retry returns the dismissed receipt");same(1,absent.provider.inserts,"A dismissed creation is never replayed");
  same("saved",store.create(absent,id(6),event("Unblocked"),false).getString("status"),"A new save is no longer pending-creation");
  refused(()->store.dismiss(absent,id(6)),"A saved creation is acknowledged, not dismissed");
  refused(()->{store.acknowledge(absent,id(5));return null;},"A dismissed creation cannot be acknowledged as saved");

  Host unreadable=new Host("unreadable");unreadable.provider.insert="throw";
  store.create(unreadable,id(7),event("Unreadable"),false);String before=journal(unreadable);
  for(String failure:new String[]{"null","throw"}){
   unreadable.provider.query=failure;
   refused(()->store.dismiss(unreadable,id(7)),"A failed provider query ("+failure+") refuses dismissal");
   same(before,journal(unreadable),"A refused dismissal leaves the journal unchanged");require(store.hasPending(unreadable),"The creation stays unknown");
  }
  same(1,unreadable.provider.inserts,"A refused dismissal never inserts");

  Host paired=new Host("paired");paired.provider.insert="throw";CalendarCreationStore options=new CalendarCreationStore("journal-options","host://creation/options/",null);
  options.create(paired,id(8),event("Option"),false);
  same("dismissed",CalendarCreationStore.dismissEither(paired,id(8),store,options),"Paired dismissal reaches the journal that owns the identity");
  require(!options.hasPending(paired)&&!store.owns(paired,id(8)),"Only the owning journal changed");

  System.out.println("PASS calendar creation journal: definite insert failure, dismiss as saved, dismissed without replay, refused on query failure, paired journals");
 }
}
