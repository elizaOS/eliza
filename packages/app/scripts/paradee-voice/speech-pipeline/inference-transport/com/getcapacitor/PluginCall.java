package com.getcapacitor;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
/** Test double: call data from a map; the settlement completes {@link #settled} (null code on resolve). */
public class PluginCall {
 public final Map<String,Object> data=new HashMap<>();
 public final CompletableFuture<String> settled=new CompletableFuture<>();
 public PluginCall put(String name,Object value){data.put(name,value);return this;}
 public String getString(String name){return (String)data.get(name);}
 public String getString(String name,String fallback){Object v=data.get(name);return v==null?fallback:(String)v;}
 public Integer getInt(String name){return (Integer)data.get(name);}
 public Integer getInt(String name,Integer fallback){Object v=data.get(name);return v==null?fallback:(Integer)v;}
 public Double getDouble(String name,Double fallback){Object v=data.get(name);return v==null?fallback:(Double)v;}
 public void resolve(JSObject result){settled.complete("RESOLVED");}
 public void reject(String message,String code){settled.complete(code);}
 public void reject(String message,String code,Exception error){settled.complete(code);}
}
