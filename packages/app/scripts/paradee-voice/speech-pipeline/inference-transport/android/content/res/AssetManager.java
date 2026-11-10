package android.content.res;
/** Test double: no packaged assets until {@link #packaged} is set, then every asset opens empty. */
public class AssetManager {
 public static volatile boolean packaged;
 public java.io.InputStream open(String path)throws java.io.IOException{
  if(packaged)return new java.io.ByteArrayInputStream(new byte[0]);
  throw new java.io.FileNotFoundException(path);
 }
}
