package android.content;
public final class ContentUris {public static android.net.Uri withAppendedId(android.net.Uri uri,long value){return uri.buildUpon().appendPath(Long.toString(value)).build();}public static android.net.Uri.Builder appendId(android.net.Uri.Builder builder,long value){return builder.appendPath(Long.toString(value));}}
