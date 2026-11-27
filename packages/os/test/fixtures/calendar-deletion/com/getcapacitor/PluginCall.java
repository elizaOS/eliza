// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package com.getcapacitor;

public class PluginCall {
  private final JSObject data;
  public JSObject result;
  public String rejected;
  public PluginCall(JSObject data) { this.data = data; }
  public JSObject getData() { return data; }
  public String getString(String key) { return getString(key, null); }
  public String getString(String key, String fallback) { Object value = data.opt(key); return value instanceof String text ? text : fallback; }
  public Long getLong(String key) { Object value = data.opt(key); return value instanceof Number number ? number.longValue() : null; }
  public Integer getInt(String key) { Object value = data.opt(key); return value instanceof Number number ? number.intValue() : null; }
  public Boolean getBoolean(String key) { Object value = data.opt(key); return value instanceof Boolean flag ? flag : null; }
  public JSObject getObject(String key) { return getObject(key, null); }
  public JSObject getObject(String key, JSObject fallback) {
    org.json.JSONObject value = data.optJSONObject(key);
    try { return value == null ? fallback : new JSObject(value.toString()); } catch (org.json.JSONException invalid) { throw new IllegalStateException(invalid); }
  }
  public JSArray getArray(String key) { return null; }
  public void resolve(JSObject value) { result = value; }
  public void reject(String message) { rejected = message; }
}
