package android.content;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
/** Test double: the application context is itself and keeps its component callbacks. */
public class Context {
 public final List<ComponentCallbacks2> callbacks=new CopyOnWriteArrayList<>();
 public Context getApplicationContext(){return this;}
 public void registerComponentCallbacks(ComponentCallbacks2 callback){callbacks.add(callback);}
 public android.content.res.AssetManager getAssets(){return new android.content.res.AssetManager();}
}
