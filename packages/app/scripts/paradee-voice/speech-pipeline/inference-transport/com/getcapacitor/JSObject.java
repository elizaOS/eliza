package com.getcapacitor;
/** Test double. */
public class JSObject extends java.util.HashMap<String,Object> {
 public JSObject put(String name,Object value){super.put(name,value);return this;}
 public boolean optBoolean(String name){return Boolean.TRUE.equals(get(name));}
 public String optString(String name){Object v=get(name);return v==null?"":v.toString();}
}
