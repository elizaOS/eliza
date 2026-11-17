package ai.eliza.plugins.messages;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.CancellationSignal;
import com.getcapacitor.JSObject;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/** Whole production deletion helper against actual SQLite predicates through a ContentProvider. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=29,manifest=Config.NONE)
public final class MessageDeletionTest {
 static SQLiteDatabase db;
 static int queries,deletes,rowUriDeletes;
 static Runnable afterQuery,beforeDelete,afterDelete;
 static boolean nullQuery,lostReply;
 static Integer forceCount;
 final AtomicBoolean access=new AtomicBoolean(true);
 public static final class Provider extends ContentProvider {
  @Override public boolean onCreate(){return true;}
  @Override public String getType(Uri uri){return null;}
  @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
  @Override public int update(Uri uri,ContentValues values,String selection,String[]args){throw new UnsupportedOperationException();}
  @Override public Cursor query(Uri uri,String[]projection,String selection,String[]args,String order){
   queries++;
   assertArrayEquals(new String[]{"_id","thread_id","date"},projection);
   if(nullQuery)return null;
   Cursor result=db.query(uri.getAuthority(),projection,selection,args,null,null,order);
   Runnable action=afterQuery;afterQuery=null;if(action!=null)action.run();
   return result;
  }
  @Override public int delete(Uri uri,String selection,String[]args){
   deletes++;Runnable action=beforeDelete;beforeDelete=null;if(action!=null)action.run();
   int count;
   if(forceCount!=null)count=forceCount;
   else if(!uri.getPathSegments().isEmpty()){
    // Real Telephony single-message endpoints select only by id and ignore caller selection.
    rowUriDeletes++;count=db.delete(uri.getAuthority(),"_id = ?",new String[]{uri.getLastPathSegment()});
   }else count=db.delete(uri.getAuthority(),selection,args);
   action=afterDelete;afterDelete=null;if(action!=null)action.run();
   if(lostReply)throw new IllegalStateException("reply lost after commit");
   return count;
  }
 }
 @Before public void setup(){
  if(db!=null)db.close();db=SQLiteDatabase.create(null);
  for(String table:new String[]{"sms","mms"})db.execSQL("CREATE TABLE "+table+" (_id INTEGER PRIMARY KEY, thread_id INTEGER, date INTEGER)");
  queries=deletes=rowUriDeletes=0;afterQuery=beforeDelete=afterDelete=null;nullQuery=lostReply=false;forceCount=null;access.set(true);
  for(String authority:new String[]{"sms","mms"}){
   ProviderInfo info=new ProviderInfo();info.authority=authority;Robolectric.buildContentProvider(Provider.class).create(info);
  }
 }
 static void row(String kind,long id,long thread,long date){db.execSQL("INSERT INTO "+kind+" VALUES (?,?,?)",new Object[]{id,thread,date});}
 static boolean exists(String kind,long id){try(Cursor c=db.rawQuery("SELECT _id FROM "+kind+" WHERE _id = ?",new String[]{Long.toString(id)})){return c.moveToFirst();}}
 static MessageDeletion.Reference reference(String kind,long id,long thread,long date)throws Exception{
  return MessageDeletion.reference(new JSONObject().put("id",kind+":"+id).put("kind",kind).put("threadId","thread:"+thread).put("date",date));
 }
 static <T>T off(Callable<T> work)throws Exception{
  java.util.concurrent.ExecutorService worker=Executors.newSingleThreadExecutor();
  try{return worker.submit(work).get();}catch(ExecutionException failure){throw(Exception)failure.getCause();}finally{worker.shutdown();}
 }
 JSObject delete(MessageDeletion.Reference ref)throws Exception{return off(()->MessageDeletion.delete(RuntimeEnvironment.getApplication(),ref,new CancellationSignal(),access::get));}
 @Test public void smsAndMmsUseDistinctTablesAndOnlyTheSelectedCollectionRow()throws Exception{
  row("sms",7,9,1700000000123L);row("sms",8,9,1700000000123L);row("mms",7,9,1700000000L);
  MessageDeletion.Reference selected=reference("sms",7,9,1700000000123L);JSObject answer=delete(selected);
  assertEquals("deleted",answer.getString("status"));assertEquals(selected.json().toString(),answer.getJSObject("message").toString());
  assertFalse(exists("sms",7));assertTrue(exists("sms",8));assertTrue(exists("mms",7));assertEquals(1,deletes);assertEquals(0,rowUriDeletes);
  assertEquals("deleted",delete(reference("mms",7,9,1700000000000L)).getString("status"));assertFalse(exists("mms",7));
 }
 @Test public void metadataRacesCannotDeleteAReplacementEvenOnProvidersWhoseRowUriIgnoresSelection()throws Exception{
  row("sms",7,9,1700000000123L);
  beforeDelete=()->db.execSQL("UPDATE sms SET thread_id=10,date=1700000000124 WHERE _id=7");
  assertEquals("stale",delete(reference("sms",7,9,1700000000123L)).getString("status"));
  assertTrue(exists("sms",7));assertEquals(1,deletes);assertEquals(0,rowUriDeletes);
 }
 @Test public void mmsUsesTheReaderNormalizationButBindsTheObservedRawDate()throws Exception{
  row("mms",7,9,1700000000123L);
  assertEquals("deleted",delete(reference("mms",7,9,1700000000123L)).getString("status"));
  row("mms",8,9,1700000000L);
  beforeDelete=()->db.execSQL("UPDATE mms SET date=1700000000000 WHERE _id=8");
  assertEquals("stale",delete(reference("mms",8,9,1700000000000L)).getString("status"));assertTrue(exists("mms",8));
 }
 @Test public void missingAndAlreadyChangedRowsNeverDispatchADelete()throws Exception{
  assertEquals("not-found",delete(reference("sms",7,9,0)).getString("status"));assertEquals(0,deletes);
  row("sms",7,10,1700000000123L);
  assertEquals("stale",delete(reference("sms",7,9,1700000000123L)).getString("status"));assertEquals(0,deletes);assertTrue(exists("sms",7));
 }
 @Test public void accessLossDuringTheIdentityReadRefusesBeforeAnyEffect()throws Exception{
  row("sms",7,9,1700000000123L);afterQuery=()->access.set(false);
  try{delete(reference("sms",7,9,1700000000123L));fail("access changed");}catch(MessageDeletion.Refused expected){assertEquals("unavailable",expected.code);}
  assertEquals(0,deletes);assertTrue(exists("sms",7));
 }
 @Test public void unavailableOrCancelledReadsDoNotDelete()throws Exception{
  row("sms",7,9,1700000000123L);nullQuery=true;
  try{delete(reference("sms",7,9,1700000000123L));fail("null cursor");}catch(MessageDeletion.Refused expected){assertEquals(0,deletes);}
  nullQuery=false;CancellationSignal cancel=new CancellationSignal();cancel.cancel();
  try{off(()->MessageDeletion.delete(RuntimeEnvironment.getApplication(),reference("sms",7,9,1700000000123L),cancel,access::get));fail("cancelled");}catch(MessageDeletion.Refused expected){assertEquals(0,deletes);}
 }
 @Test public void lostEffectReplyIsUnknownWithOneDispatchAndNoRetry()throws Exception{
  row("sms",7,9,1700000000123L);lostReply=true;
  assertEquals("unknown",delete(reference("sms",7,9,1700000000123L)).getString("status"));assertFalse(exists("sms",7));assertEquals(1,deletes);
 }
 @Test public void knownDeletionSurvivesAccessLossAfterTheEffect()throws Exception{
  row("sms",7,9,1700000000123L);afterDelete=()->access.set(false);
  assertEquals("deleted",delete(reference("sms",7,9,1700000000123L)).getString("status"));assertEquals(1,deletes);
 }
 @Test public void unexplainedZeroAndInvalidCountsAreNeverConfirmedDeleted()throws Exception{
  row("sms",7,9,1700000000123L);forceCount=0;
  assertEquals("unknown",delete(reference("sms",7,9,1700000000123L)).getString("status"));assertTrue(exists("sms",7));assertEquals(1,deletes);
  forceCount=2;assertEquals("unknown",delete(reference("sms",7,9,1700000000123L)).getString("status"));assertTrue(exists("sms",7));
 }
 @Test public void concurrentExternalRemovalReportsMissingNotAnUnprovenOwnDeletion()throws Exception{
  row("sms",7,9,1700000000123L);beforeDelete=()->db.delete("sms","_id = ?",new String[]{"7"});
  assertEquals("not-found",delete(reference("sms",7,9,1700000000123L)).getString("status"));assertEquals(1,deletes);
 }
 @Test public void malformedIdentityNeverReachesTheProvider()throws Exception{
  for(JSONObject bad:new JSONObject[]{new JSONObject().put("id","mms:7").put("kind","sms").put("threadId","thread:9").put("date",0),
    new JSONObject().put("id","sms:7").put("kind","sms").put("threadId","9").put("date",0),
    new JSONObject().put("id","sms:7").put("kind","sms").put("threadId","thread:9").put("date",0).put("extra",true)}){
   try{MessageDeletion.reference(bad);fail("bad reference");}catch(IllegalArgumentException expected){assertEquals(0,queries);assertEquals(0,deletes);}
  }
 }
}
