package ai.eliza.plugins.filesystem.browser;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.FileNotFoundException;
/** Read-only URIs for files the owner opens or shares from Files. Hidden entries (the trash
 * included) are never served. */
public final class ReadOnlyStorageFileProvider extends androidx.core.content.FileProvider {
 @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{
  if(!"r".equals(mode))throw new FileNotFoundException("Read-only");
  for(String segment:uri.getPathSegments())if(segment.startsWith("."))throw new FileNotFoundException();
  return super.openFile(uri,mode);
 }
}
