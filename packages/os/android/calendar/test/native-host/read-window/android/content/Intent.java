package android.content;
public final class Intent {
 public static final String ACTION_INSERT="android.intent.action.INSERT";
 public Intent(String action){}public Intent setData(android.net.Uri uri){return this;}
 public Intent putExtra(String key,String value){return this;}public Intent putExtra(String key,long value){return this;}
}
