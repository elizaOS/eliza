package android.net;
public final class Uri {public final String value;public Uri(String value){this.value=value;}public Builder buildUpon(){return new Builder(value);}public static final class Builder {private String value;Builder(String value){this.value=value;}public Builder appendPath(String part){value+="/"+part;return this;}public Uri build(){return new Uri(value);}}}
