package android.net;

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class Uri {
  private final String scheme, authority, path, query, fragment;

  private Uri(String scheme, String authority, String path, String query, String fragment) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  public static Uri parse(String value) {
    URI parsed = URI.create(value);
    return new Uri(parsed.getScheme(), parsed.getRawAuthority(), parsed.getRawPath(), parsed.getRawQuery(), parsed.getRawFragment());
  }

  public static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
  }

  public String getScheme() { return scheme; }
  public String getAuthority() { return authority; }
  public String getEncodedAuthority() { return authority; }
  public String getPath() { return path == null ? null : URLDecoder.decode(path, StandardCharsets.UTF_8); }
  public String getEncodedPath() { return path; }
  public String getEncodedQuery() { return query; }
  public String getEncodedFragment() { return fragment; }

  public List<String> getQueryParameters(String key) {
    List<String> values = new ArrayList<>();
    if (query == null) return values;
    for (String pair : query.split("&")) {
      int split = pair.indexOf('=');
      String name = URLDecoder.decode(split < 0 ? pair : pair.substring(0, split), StandardCharsets.UTF_8);
      if (name.equals(key)) values.add(split < 0 ? "" : URLDecoder.decode(pair.substring(split + 1), StandardCharsets.UTF_8));
    }
    return values;
  }

  public String getQueryParameter(String key) {
    List<String> values = getQueryParameters(key);
    return values.isEmpty() ? null : values.get(0);
  }

  public Builder buildUpon() {
    return new Builder(scheme, authority, path, query, fragment);
  }

  @Override public String toString() {
    return (scheme == null ? "" : scheme + ":") + (authority == null ? "" : "//" + authority) + (path == null ? "" : path)
        + (query == null ? "" : "?" + query) + (fragment == null ? "" : "#" + fragment);
  }

  @Override public boolean equals(Object other) {
    return other instanceof Uri uri && toString().equals(uri.toString());
  }

  @Override public int hashCode() { return toString().hashCode(); }

  public static final class Builder {
    private String scheme, authority, path, query, fragment;

    public Builder() {}

    private Builder(String scheme, String authority, String path, String query, String fragment) {
      this.scheme = scheme;
      this.authority = authority;
      this.path = path;
      this.query = query;
      this.fragment = fragment;
    }

    public Builder path(String value) {
      path = value;
      return this;
    }

    public Builder fragment(String value) {
      fragment = value == null ? null : encode(value);
      return this;
    }

    public Builder appendQueryParameter(String key, String value) {
      String pair = encode(key) + "=" + encode(value);
      query = query == null ? pair : query + "&" + pair;
      return this;
    }

    public Uri build() {
      return new Uri(scheme, authority, path, query, fragment);
    }
  }
}
