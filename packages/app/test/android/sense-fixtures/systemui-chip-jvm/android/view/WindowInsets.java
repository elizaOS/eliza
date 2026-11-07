package android.view;
public final class WindowInsets {
 public android.graphics.Insets stubInsets=new android.graphics.Insets();
 public android.graphics.Insets getInsetsIgnoringVisibility(int types){return stubInsets;}
 public static final class Type {public static int statusBars(){return 1;}public static int systemBars(){return 3;}public static int displayCutout(){return 4;}}
}
