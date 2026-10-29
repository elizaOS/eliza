package org.json;

import java.util.ArrayList;
import java.util.List;

public class JSONArray {
    final List<Object> values = new ArrayList<>();
    public JSONArray() {}
    public JSONArray put(Object value) { values.add(value); return this; }
    public int length() { return values.size(); }
    public Object get(int index) throws JSONException { if (index < 0 || index >= values.size()) throw new JSONException("index"); return values.get(index); }
    public Object opt(int index) { return index < 0 || index >= values.size() ? null : values.get(index); }
    public JSONObject optJSONObject(int index) { Object v = opt(index); return v instanceof JSONObject ? (JSONObject) v : null; }
    public JSONObject getJSONObjectAt(int index) { return optJSONObject(index); }
    @Override public String toString() {
        StringBuilder out = new StringBuilder("[");
        for (Object v : values) { if (out.length() > 1) out.append(','); out.append(JSONParser.write(v)); }
        return out.append(']').toString();
    }
}
