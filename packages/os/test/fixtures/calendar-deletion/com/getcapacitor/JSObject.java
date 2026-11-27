// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package com.getcapacitor;

public class JSObject extends org.json.JSONObject {
  public JSObject() {}
  public JSObject(String json) throws org.json.JSONException { super(json); }
  @Override public JSObject put(String key, Object value) { try { super.put(key, value); } catch (org.json.JSONException invalid) { throw new IllegalArgumentException(invalid); } return this; }
  @Override public JSObject put(String key, boolean value) { return put(key, (Object) value); }
  @Override public JSObject put(String key, int value) { return put(key, (Object) value); }
  @Override public JSObject put(String key, long value) { return put(key, (Object) value); }
  public String getString(String key, String fallback) { Object value = opt(key); return value instanceof String text ? text : fallback; }
}
