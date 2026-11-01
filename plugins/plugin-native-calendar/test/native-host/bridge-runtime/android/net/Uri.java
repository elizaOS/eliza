package android.net;
public final class Uri {
 public final String value;public Uri(String value){this.value=value;}
 public static Uri parse(String value){return new Uri(value);}
 private java.net.URI parsed(){return java.net.URI.create(value);}
 public String getScheme(){return parsed().getScheme();}public String getAuthority(){return parsed().getAuthority();}public String getQuery(){return parsed().getQuery();}public String getFragment(){return parsed().getFragment();}
 public Builder buildUpon(){return new Builder(value);}public String toString(){return value;}
 public static final class Builder {private String value;Builder(String value){this.value=value;}public Builder appendQueryParameter(String key,String item){return this;}public Builder appendPath(String part){value+="/"+part;return this;}public Uri build(){return new Uri(value);}}
}
