package android.content;
/** Test double: Android's trim levels. */
public interface ComponentCallbacks2 {
 int TRIM_MEMORY_RUNNING_MODERATE=5,TRIM_MEMORY_RUNNING_LOW=10,TRIM_MEMORY_RUNNING_CRITICAL=15,
  TRIM_MEMORY_UI_HIDDEN=20,TRIM_MEMORY_BACKGROUND=40,TRIM_MEMORY_MODERATE=60,TRIM_MEMORY_COMPLETE=80;
 void onTrimMemory(int level);
 void onLowMemory();
 void onConfigurationChanged(android.content.res.Configuration configuration);
}
