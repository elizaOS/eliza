package ai.eliza.plugins.calendar.read;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.provider.CalendarContract;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Read-only Calendar source identity. Mutation assertions reuse the same canonical fields and hash. */
public final class CalendarSourceIdentity {
 private static final String[] FIELDS={"_id","account_name","account_type","name","calendar_access_level","ownerAccount"};
 private CalendarSourceIdentity() {}
 /** Canonical Calendars columns, in hash order. */
 public static String[] fields(){return FIELDS.clone();}
 public static JSONObject read(ContentResolver resolver,long id)throws Exception {
  if(id<=0)throw new IllegalArgumentException();ContentValues values=null;
  try(Cursor row=resolver.query(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,id),FIELDS,null,null,null)){
   if(row!=null&&row.moveToFirst()){values=new ContentValues();for(int i=0;i<FIELDS.length;i++){if(row.isNull(i))values.putNull(FIELDS[i]);else if(row.getType(i)==Cursor.FIELD_TYPE_INTEGER)values.put(FIELDS[i],row.getLong(i));else values.put(FIELDS[i],row.getString(i));}if(row.moveToNext())throw new IllegalStateException("Ambiguous calendar");}
  }
  if(values==null)throw new IllegalStateException("Calendar source unavailable");
  String account=values.getAsString("account_name");
  return new JSONObject().put("id",Long.toString(id)).put("account",account==null?"":account).put("sourceRevision",digest(values));
 }
 /** SHA-256 of the canonical source fields of one Calendars row. */
 public static String digest(ContentValues values)throws Exception {
  StringBuilder source=new StringBuilder();
  for(String key:FIELDS){Object value=values.get(key);source.append(key.length()).append(':').append(key).append(value==null?"N":"V"+value.toString().length()+":"+value.toString()).append(';');}
  byte[] bytes=MessageDigest.getInstance("SHA-256").digest(source.toString().getBytes(StandardCharsets.UTF_8));
  StringBuilder result=new StringBuilder();for(byte b:bytes)result.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return result.toString();
 }
}
