package ai.eliza.plugins.notifications;

import org.json.JSONObject;

/** Owner identity (origin, owner, agent) shared by every owner-specific notice route. */
public final class NoticeOwner {
 private static final String[] FIELDS={"origin","ownerId","agentId"};
 private NoticeOwner(){}
 public static JSONObject identity(JSONObject value)throws Exception {
  if(value==null)return null;
  if(value.length()!=3)throw new IllegalArgumentException("Invalid notice owner");
  JSONObject result=new JSONObject();
  for(String key:FIELDS){Object raw=value.get(key);if(!(raw instanceof String))throw new IllegalArgumentException("Invalid notice owner");String text=(String)raw;if(text.isBlank()||text.length()>(key.equals("origin")?2048:128)||text.indexOf('\0')>=0)throw new IllegalArgumentException("Invalid notice owner");result.put(key,text);}
  return result;
 }
 /** A missing owner (signed out) matches no route. */
 public static boolean matches(JSONObject owner,JSONObject route)throws Exception {
  if(owner==null)return false;owner=identity(owner);
  for(String key:FIELDS)if(!owner.getString(key).equals(route.getString(key)))return false;
  return true;
 }
 public static JSONObject fromRoute(JSONObject route)throws Exception {JSONObject result=new JSONObject();for(String key:FIELDS)result.put(key,route.getString(key));return identity(result);}
}
