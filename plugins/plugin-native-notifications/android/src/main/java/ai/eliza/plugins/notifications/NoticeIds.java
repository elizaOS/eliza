package ai.eliza.plugins.notifications;

import java.util.Collection;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Opaque, per-process identifiers for OS notification keys and channel IDs handed to a renderer.
 * The renderer never sees an Android key; a key that disappears is forgotten on the next
 * {@link #retain}, and {@link #clear} (on pause) invalidates every identifier the renderer holds.
 * No Android types, so the mapping is host-tested.
 */
public final class NoticeIds {
 private final Map<String,String> ids=new ConcurrentHashMap<>();
 /** The identifier for key, created once and stable until it is forgotten. */
 public String id(String key){return ids.computeIfAbsent(key,k->UUID.randomUUID().toString());}
 /** The key an identifier names, or null when it is unknown or was forgotten. */
 public String key(String id){
  if(id==null||id.isEmpty())return null;
  for(Map.Entry<String,String> entry:ids.entrySet())if(entry.getValue().equals(id))return entry.getKey();
  return null;
 }
 /** True when id currently names key. */
 public boolean names(String id,String key){return id!=null&&id.equals(ids.get(key));}
 /** Forgets every key not in current. */
 public void retain(Collection<String> current){ids.keySet().retainAll(current);}
 public void clear(){ids.clear();}
 /** A renderer-visible value bounded to limit UTF-16 units; null is the empty string. */
 public static String bounded(CharSequence text,int limit){
  String value=text==null?"":text.toString();
  if(value.length()<=limit)return value;
  if(limit<1)return "";
  // Do not split a surrogate pair at the bound.
  int end=Character.isHighSurrogate(value.charAt(limit-1))?limit-1:limit;
  return value.substring(0,end);
 }
}
