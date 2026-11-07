package android.net;
public abstract class Uri {
 public static Uri parse(String text){return new Uri(){@Override public String toString(){return text;}};}
}
