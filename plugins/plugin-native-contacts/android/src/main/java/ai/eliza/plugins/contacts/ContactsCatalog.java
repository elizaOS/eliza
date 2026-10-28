package ai.eliza.plugins.contacts;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import android.provider.ContactsContract;
import com.getcapacitor.*;

/**
 * Bounded same-profile Contacts provider reads for hosts that show an address book on their AOSP
 * image. A page holds at most 200 contacts and 1 MiB of records, each field at most 1024 characters
 * and 32 phone numbers or emails; a larger record or page is refused rather than truncated. Reads take
 * the caller's CancellationSignal and time out after five seconds. No contact cache, upload or
 * cross-profile lookup URI. {@link #reviewed} rechecks a selected contact's lookup key and revision
 * before an edit is handed to the system editor. Call {@link #list} and {@link #reviewed} off the main
 * thread: the timeout is posted to the main looper, so a main-thread call could never time out and is
 * refused.
 */
public final class ContactsCatalog {
 private final ContentResolver resolver;
 public ContactsCatalog(Context context){resolver=context.getContentResolver();}
 private static final String[] FIELDS={ContactsContract.Contacts._ID,ContactsContract.Contacts.LOOKUP_KEY,ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,ContactsContract.Contacts.CONTACT_LAST_UPDATED_TIMESTAMP,ContactsContract.Contacts.STARRED};
 private static String text(String value){if(value==null)return "";if(value.length()>1024)throw new IllegalArgumentException("Contact field too large");return value;}
 private static void offMain(){if(Looper.myLooper()==Looper.getMainLooper())throw new IllegalStateException("Contacts reads must run off the main thread");}
 public static void queryBounds(String query,int limit){if(query==null||query.length()>128||query.indexOf('\0')>=0||limit<1||limit>200)throw new IllegalArgumentException("Invalid Contacts query");}
 public static Uri searchUri(String query){return query.isBlank()?ContactsContract.Contacts.CONTENT_URI:Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_FILTER_URI,Uri.encode(query.trim()));}
 public static int admitRecordBytes(int used,String record){int next=used+record.getBytes(java.nio.charset.StandardCharsets.UTF_8).length+1;if(next>1024*1024)throw new IllegalStateException("Contact page too large; narrow the search");return next;}
 public JSObject list(String query,int limit)throws Exception{return list(query,limit,new CancellationSignal());}
 public JSObject list(String query,int limit,CancellationSignal signal)throws Exception{
  offMain();queryBounds(query,limit);Uri uri=searchUri(query);int bytes=64;
  JSArray records=new JSArray();boolean more=false;
  Handler main=new Handler(Looper.getMainLooper());Runnable timeout=signal::cancel;main.postDelayed(timeout,5000);
  try(Cursor rows=resolver.query(uri,FIELDS,null,null,ContactsContract.Contacts.DISPLAY_NAME_PRIMARY+" COLLATE LOCALIZED ASC, "+ContactsContract.Contacts._ID+" ASC",signal)){
   if(rows==null)throw new IllegalStateException("Contacts provider unavailable");
   while(rows.moveToNext()){
    if(records.length()==limit){more=true;break;}
    JSObject row=new JSObject();String id=rows.getString(0),lookup=text(rows.getString(1)),updated=rows.getString(3);
    row.put("id",id);row.put("lookup",lookup);row.put("name",text(rows.getString(2)));row.put("revision",updated);row.put("starred",rows.getInt(4)!=0);
    row.put("phones",details(id,ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,signal));row.put("emails",details(id,ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,signal));bytes=admitRecordBytes(bytes,row.toString());records.put(row);
   }
  }finally{main.removeCallbacks(timeout);}
  JSObject result=new JSObject();result.put("contacts",records);result.put("more",more);return result;
 }
 private JSArray details(String id,String mime,CancellationSignal signal){
  JSArray result=new JSArray();try(Cursor rows=resolver.query(ContactsContract.Data.CONTENT_URI,new String[]{ContactsContract.Data.DATA1},ContactsContract.Data.CONTACT_ID+"=? AND "+ContactsContract.Data.MIMETYPE+"=?",new String[]{id,mime},ContactsContract.Data._ID+" ASC",signal)){
   if(rows==null)throw new IllegalStateException("Contact fields unavailable");while(rows.moveToNext()){if(result.length()>=32)throw new IllegalStateException("Contact has too many fields");result.put(text(rows.getString(0)));}
  }return result;
 }
 public Uri reviewed(String id,String lookup,String revision){
  if(id==null||!id.matches("[1-9][0-9]{0,18}")||lookup==null||lookup.isBlank()||lookup.length()>1024||revision==null)throw new IllegalArgumentException("Selected contact required");
  offMain();Uri uri=ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI,Long.parseLong(id));
  CancellationSignal signal=new CancellationSignal();Handler main=new Handler(Looper.getMainLooper());Runnable timeout=signal::cancel;main.postDelayed(timeout,5000);
  try(Cursor row=resolver.query(uri,FIELDS,null,null,null,signal)){
   if(row==null||!row.moveToFirst()||!lookup.equals(row.getString(1))||!revision.equals(row.getString(3)))throw new IllegalArgumentException("Contact changed");
  }
  finally{main.removeCallbacks(timeout);}
  return ContactsContract.Contacts.getLookupUri(Long.parseLong(id),lookup);
 }
}
