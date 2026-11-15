package android.util;
public final class Base64 {
 public static final int NO_WRAP=2;
 public static String encodeToString(byte[] bytes,int flags){return java.util.Base64.getEncoder().encodeToString(bytes);}
 public static byte[] decode(String text,int flags){return java.util.Base64.getDecoder().decode(text);}
}
