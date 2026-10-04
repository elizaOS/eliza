package ai.eliza.plugins.agent.updater;

import android.system.*;
import java.io.*;
import java.nio.file.Path;

public final class AndroidUpdateStorage {
  private AndroidUpdateStorage() {}
  public static void sync(Path directory) throws IOException {
    FileDescriptor descriptor=null;
    try {
      descriptor=Os.open(directory.toString(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);
      if(!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode))throw new IOException("Updater sync target is not a directory");
      Os.fsync(descriptor);
    } catch(ErrnoException e){throw new IOException("Cannot sync updater state",e);}
    finally {if(descriptor!=null)try{Os.close(descriptor);}catch(ErrnoException e){throw new IOException("Cannot close updater state",e);}}
  }
}
