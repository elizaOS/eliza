package android.os;
import java.util.HashMap;
import java.util.Map;
public final class Bundle {
 private final Map<String,Object> values=new HashMap<>();
 public void putBinder(String key,IBinder value){values.put(key,value);}
 public IBinder getBinder(String key){Object v=values.get(key);return v instanceof IBinder?(IBinder)v:null;}
 public void putLong(String key,long value){values.put(key,value);}
 public long getLong(String key,long fallback){Object v=values.get(key);return v instanceof Long?(Long)v:fallback;}
 public void putBoolean(String key,boolean value){values.put(key,value);}
 public boolean getBoolean(String key,boolean fallback){Object v=values.get(key);return v instanceof Boolean?(Boolean)v:fallback;}
 public void putString(String key,String value){values.put(key,value);}
 public String getString(String key){Object v=values.get(key);return v instanceof String?(String)v:null;}
 public String getString(String key,String fallback){String v=getString(key);return v==null?fallback:v;}
 public java.util.Set<String> keySet(){return values.keySet();}
}
