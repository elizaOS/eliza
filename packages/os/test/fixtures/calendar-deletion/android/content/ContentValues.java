// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.content;

public final class ContentValues {
  private final java.util.LinkedHashMap<String, Object> values = new java.util.LinkedHashMap<>();
  public ContentValues() {}
  public ContentValues(ContentValues from) { values.putAll(from.values); }
  public void put(String key, String value) { values.put(key, value); }
  public void put(String key, Integer value) { values.put(key, value); }
  public void put(String key, Long value) { values.put(key, value); }
  public void put(String key, Boolean value) { values.put(key, value); }
  public void putNull(String key) { values.put(key, null); }
  public Object get(String key) { return values.get(key); }
  public boolean containsKey(String key) { return values.containsKey(key); }
  public java.util.Set<String> keySet() { return values.keySet(); }
  public int size() { return values.size(); }
  public String getAsString(String key) { Object value = values.get(key); return value == null ? null : value.toString(); }
  public Long getAsLong(String key) { Object value = values.get(key); return value instanceof Number number ? Long.valueOf(number.longValue()) : value instanceof Boolean flag ? Long.valueOf(flag ? 1 : 0) : value == null ? null : Long.valueOf(value.toString()); }
  public Integer getAsInteger(String key) { Long value = getAsLong(key); return value == null ? null : value.intValue(); }
  @Override public boolean equals(Object other) { return other instanceof ContentValues that && values.equals(that.values); }
  @Override public int hashCode() { return values.hashCode(); }
  @Override public String toString() { return values.toString(); }
}
