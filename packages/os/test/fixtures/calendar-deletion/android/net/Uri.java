// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.net;

public final class Uri {
  private final java.net.URI value;
  private Uri(String text) { value = java.net.URI.create(text); }
  public static Uri parse(String text) { return new Uri(text); }
  public String getScheme() { return value.getScheme(); }
  public String getAuthority() { return value.getAuthority(); }
  public String getQuery() { return value.getQuery(); }
  public String getFragment() { return value.getFragment(); }
  public java.util.List<String> getPathSegments() { return java.util.Arrays.stream(value.getPath().split("/")).filter(segment -> !segment.isEmpty()).toList(); }
  public Builder buildUpon() { return new Builder(toString()); }
  @Override public String toString() { return value.toString(); }
  @Override public boolean equals(Object other) { return other instanceof Uri that && value.equals(that.value); }
  @Override public int hashCode() { return value.hashCode(); }
  public static final class Builder {
    private final StringBuilder text;
    private Builder(String text) { this.text = new StringBuilder(text); }
    public Builder appendPath(String segment) { text.append('/').append(segment); return this; }
    public Builder appendQueryParameter(String key, String value) { text.append(text.indexOf("?") < 0 ? '?' : '&').append(key).append('=').append(value); return this; }
    public Uri build() { return new Uri(text.toString()); }
  }
}
