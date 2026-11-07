package org.json;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/** Plain-JVM stand-in for Android's org.json used by the crash-log host test: real JSON text in and out. */
public class JSONObject {
    public static final Object NULL = new Object();
    final Map<String, Object> values = new LinkedHashMap<>();
    public JSONObject() {}
    public JSONObject(String text) throws JSONException {
        Object value = JSONParser.parse(text);
        if (!(value instanceof JSONObject)) throw new JSONException("not an object");
        values.putAll(((JSONObject) value).values);
    }
    public JSONObject put(String key, Object value) throws JSONException { values.put(key, value); return this; }
    public JSONObject put(String key, long value) throws JSONException { values.put(key, value); return this; }
    public JSONObject put(String key, int value) throws JSONException { values.put(key, value); return this; }
    public boolean has(String key) { return values.containsKey(key); }
    public Object opt(String key) { return values.get(key); }
    public int length() { return values.size(); }
    public Iterator<String> keys() { return values.keySet().iterator(); }
    public int optInt(String key) { Object v = opt(key); return v instanceof Number ? ((Number) v).intValue() : 0; }
    public long optLong(String key, long fallback) { Object v = opt(key); return v instanceof Number ? ((Number) v).longValue() : fallback; }
    public String optString(String key, String fallback) { Object v = opt(key); return v instanceof String ? (String) v : fallback; }
    public String getString(String key) throws JSONException { Object v = opt(key); if (!(v instanceof String)) throw new JSONException(key); return (String) v; }
    public JSONArray optJSONArray(String key) { Object v = opt(key); return v instanceof JSONArray ? (JSONArray) v : null; }
    public JSONArray getJSONArray(String key) throws JSONException { JSONArray v = optJSONArray(key); if (v == null) throw new JSONException(key); return v; }
    public JSONObject optJSONObject(String key) { Object v = opt(key); return v instanceof JSONObject ? (JSONObject) v : null; }
    @Override public String toString() {
        StringBuilder out = new StringBuilder("{");
        for (Map.Entry<String, Object> e : values.entrySet()) {
            if (out.length() > 1) out.append(',');
            out.append(JSONParser.quote(e.getKey())).append(':').append(JSONParser.write(e.getValue()));
        }
        return out.append('}').toString();
    }
}
