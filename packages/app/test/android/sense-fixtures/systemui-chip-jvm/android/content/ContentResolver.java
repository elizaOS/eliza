package android.content;
import android.net.Uri;
import android.os.Bundle;
/** Host stub: tests install a handler that stands in for the listener's lease provider. */
public class ContentResolver {
 public interface Handler{Bundle call(Uri uri,String method,String arg,Bundle extras);}
 public Handler handler;
 public final Bundle call(Uri uri,String method,String arg,Bundle extras){
  if(handler==null)throw new IllegalArgumentException("Unknown authority");
  return handler.call(uri,method,arg,extras);
 }
}
