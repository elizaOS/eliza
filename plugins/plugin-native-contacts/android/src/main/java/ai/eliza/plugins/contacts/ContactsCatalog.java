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
 * cross-profile lookup URI. A page with more contacts after it returns an opaque {@code next} cursor;
 * passing it back with the same query reads the following page, and a cursor whose page boundary has
 * changed since is refused with {@link StaleCursor} instead of skipping or repeating contacts.
 * {@link #reviewed} rechecks a selected contact's lookup key and revision
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
 /** The page boundary changed after the cursor was issued; read again from the first page. */
 public static final class StaleCursor extends IllegalStateException {
  private static final long serialVersionUID=1L;
  StaleCursor(){super("Contacts changed; read again from the first page");}
 }
 /** Opaque page cursor: rows already read, the id of the last of them, and the query it belongs to. */
 private static final class Page {
  final int offset;final String lastId,query;
  Page(int offset,String lastId,String query){this.offset=offset;this.lastId=lastId;this.query=query;}
  String encode(){return "v1."+offset+"."+lastId+"."+Uri.encode(query);}
  static Page decode(String value){
   if(value==null)return null;String[] parts=value.split("\\.",4);
   if(parts.length!=4||!parts[0].equals("v1")||!parts[1].matches("[1-9][0-9]{0,8}")||!parts[2].matches("[1-9][0-9]{0,18}"))throw new IllegalArgumentException("Invalid Contacts cursor");
   return new Page(Integer.parseInt(parts[1]),parts[2],Uri.decode(parts[3]));
  }
 }
 public JSObject list(String query,int limit)throws Exception{return list(query,limit,null,new CancellationSignal());}
 public JSObject list(String query,int limit,CancellationSignal signal)throws Exception{return list(query,limit,null,signal);}
 /** One page; {@code cursor} is null for the first page or the {@code next} value of the previous page. */
 public JSObject list(String query,int limit,String cursor,CancellationSignal signal)throws Exception{
  offMain();queryBounds(query,limit);Page page=Page.decode(cursor);
  if(page!=null&&!page.query.equals(query))throw new IllegalArgumentException("Cursor belongs to another query");
  Uri uri=searchUri(query);int bytes=64;
  JSArray records=new JSArray();boolean more=false;String lastId=null;
  Handler main=new Handler(Looper.getMainLooper());Runnable timeout=signal::cancel;main.postDelayed(timeout,5000);
  try(Cursor rows=resolver.query(uri,FIELDS,null,null,ContactsContract.Contacts.DISPLAY_NAME_PRIMARY+" COLLATE LOCALIZED ASC, "+ContactsContract.Contacts._ID+" ASC",signal)){
   if(rows==null)throw new IllegalStateException("Contacts provider unavailable");
   if(page!=null&&(!rows.moveToPosition(page.offset-1)||!page.lastId.equals(rows.getString(0))))throw new StaleCursor();
   while(rows.moveToNext()){
    if(records.length()==limit){more=true;break;}
    JSObject row=new JSObject();String id=rows.getString(0),lookup=text(rows.getString(1)),updated=rows.getString(3);
    row.put("id",id);row.put("lookup",lookup);row.put("name",text(rows.getString(2)));row.put("revision",updated);row.put("starred",rows.getInt(4)!=0);
    row.put("phones",details(id,ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,signal));row.put("emails",details(id,ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,signal));bytes=admitRecordBytes(bytes,row.toString());records.put(row);lastId=id;
   }
  }finally{main.removeCallbacks(timeout);}
  JSObject result=new JSObject();result.put("contacts",records);result.put("more",more);
  if(more)result.put("next",new Page((page==null?0:page.offset)+records.length(),lastId,query).encode());
  return result;
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
