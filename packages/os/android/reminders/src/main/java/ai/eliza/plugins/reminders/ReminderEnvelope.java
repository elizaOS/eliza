package ai.eliza.plugins.reminders;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import org.json.JSONException;
import java.util.*;

/** One durable commit for reminder rows and operation metadata. Caller holds ReminderStore lock. */
final class ReminderEnvelope {
 private static final String KEY="envelope";
 private final ReminderStore owner;
 private final State state;
 static final class State { final LinkedHashMap<SharedPreferences,Cache> cache=new LinkedHashMap<>(8,0.75f,true); boolean quarantined; }
 private static final class Cache{final String raw;final JSONObject value;Cache(String raw,JSONObject value){this.raw=raw;this.value=value;}}
 // SharedPreferences changes its memory map before disk commit. Once any write is
 // uncertain, no wrapper or receipt may trust that process memory again. There is
 // deliberately no reset API: only a fresh process can reload durable storage.

 private void requireDurable(){if(state.quarantined)throw new IllegalStateException("Reminder storage requires app restart after failed persistence");}
 private final SharedPreferences disk;
 private void persist(String raw){
  requireDurable();
  boolean committed=false;
  try{committed=disk.edit().putString(KEY,raw).commit();if(!committed)throw new IllegalStateException("Reminder storage unavailable");}
  finally{if(!committed){state.quarantined=true;synchronized(state.cache){state.cache.clear();}}}
 }
 private void remember(String raw){synchronized(state.cache){state.cache.put(disk,new Cache(raw,value));while(state.cache.size()>2)state.cache.remove(state.cache.keySet().iterator().next());}}
 private void invalidate(){synchronized(state.cache){state.cache.remove(disk);}}

 JSONObject value;
 private JSONObject transaction;
 ReminderEnvelope(Context context,ReminderStore owner) {
  this.owner=owner;this.state=owner.persistence;
  requireDurable();
  disk=context.getSharedPreferences(owner.configuration.envelopeName,Context.MODE_PRIVATE);
  try {
   String saved=disk.getString(KEY,null);
   if(saved!=null){synchronized(state.cache){Cache cached=state.cache.get(disk);if(cached!=null&&saved.equals(cached.raw)){value=cached.value;return;}}value=new JSONObject(saved);if(value.getInt("version")!=1)throw new IllegalStateException("Unsupported reminder storage");value.getJSONObject("records");value.getJSONObject("operations");remember(saved);return;}
   JSONObject records=new JSONObject(),archive=new JSONObject();
   for(Map.Entry<String,?> entry:context.getSharedPreferences(owner.configuration.legacyName,Context.MODE_PRIVATE).getAll().entrySet()){
    // Preserve malformed neighboring values verbatim, including their scalar type.
    Object raw=entry.getValue();archive.put(entry.getKey(),raw instanceof Set?new org.json.JSONArray((Set<?>)raw):raw);
    records.put(entry.getKey(),raw instanceof Set?new org.json.JSONArray((Set<?>)raw):raw);
   }
   value=new JSONObject().put("version",1).put("source",UUID.randomUUID().toString()).put("records",records).put("legacyArchive",archive).put("operations",new JSONObject());
   save();
  }catch(JSONException error){throw new IllegalStateException("Reminder storage is invalid",error);}
 }
 JSONObject active(){requireDurable();return transaction==null?value:transaction;}
 void begin(){requireDurable();if(transaction!=null)throw new IllegalStateException("Reminder transaction busy");try{transaction=new JSONObject(value.toString());}catch(JSONException error){throw new IllegalStateException(error);}}
 void abort(){transaction=null;}
 private String encoded(JSONObject next){String encoded=next.toString();if(encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>8*1024*1024){invalidate();throw new IllegalStateException("Reminder storage full");}return encoded;}
 void commit(){requireDurable();if(transaction==null)throw new IllegalStateException("No reminder transaction");JSONObject next=transaction;String raw=encoded(next);persist(raw);value=next;transaction=null;remember(raw);}
 void save(){requireDurable();if(transaction!=null)return;String raw=encoded(value);persist(raw);remember(raw);}
 SharedPreferences records(){return new Rows();}
 private final class Rows implements SharedPreferences {
  private JSONObject data(){try{return active().getJSONObject("records");}catch(JSONException e){throw new IllegalStateException(e);}}
  public Map<String,?> getAll(){Map<String,Object> m=new HashMap<>();JSONObject d=data();for(Iterator<String> i=d.keys();i.hasNext();){String k=i.next();m.put(k,d.opt(k));}return m;}
  public String getString(String k,String fallback){Object v=data().opt(k);if(v==null)return fallback;if(!(v instanceof String))throw new ClassCastException();return (String)v;}
  public boolean contains(String k){return data().has(k);}
  public Set<String> getStringSet(String k,Set<String> fallback){throw new UnsupportedOperationException();}
  public int getInt(String k,int fallback){Object v=data().opt(k);if(v==null)return fallback;if(!(v instanceof Integer))throw new ClassCastException();return (Integer)v;}
  public long getLong(String k,long fallback){throw new UnsupportedOperationException();}
  public float getFloat(String k,float fallback){throw new UnsupportedOperationException();}
  public boolean getBoolean(String k,boolean fallback){throw new UnsupportedOperationException();}
  public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l){throw new UnsupportedOperationException();}
  public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l){}
  public Editor edit(){return new Editor(){
   final Map<String,Object> writes=new HashMap<>();final Set<String> removes=new HashSet<>();boolean clear;
   public Editor putString(String k,String v){if(v==null)return remove(k);writes.put(k,v);removes.remove(k);return this;}
   public Editor remove(String k){writes.remove(k);removes.add(k);return this;}
   public Editor clear(){clear=true;return this;}
   public Editor putStringSet(String k,Set<String> v){throw new UnsupportedOperationException();}
   public Editor putInt(String k,int v){writes.put(k,v);removes.remove(k);return this;}
   public Editor putLong(String k,long v){throw new UnsupportedOperationException();}
   public Editor putFloat(String k,float v){throw new UnsupportedOperationException();}
   public Editor putBoolean(String k,boolean v){throw new UnsupportedOperationException();}
   public boolean commit(){try{JSONObject before=new JSONObject(active().toString());JSONObject d=clear?new JSONObject():data();for(String k:removes)d.remove(k);for(Map.Entry<String,Object> e:writes.entrySet())d.put(e.getKey(),e.getValue());active().put("records",d);try{save();return true;}catch(RuntimeException failure){invalidate();if(transaction==null)value=before;else transaction=before;return false;}}catch(JSONException e){throw new IllegalStateException(e);}}
   public void apply(){if(!commit())throw new IllegalStateException("Reminder storage unavailable");}
  };}
 }
}
