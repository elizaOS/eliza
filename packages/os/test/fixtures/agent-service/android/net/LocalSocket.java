package android.net;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public final class LocalSocket implements Closeable {
  public void connect(LocalSocketAddress address) throws IOException {
    throw new AssertionError("NativeAsk must use its injected link");
  }

  public Credentials getPeerCredentials() throws IOException {
    throw new AssertionError("NativeAsk must use its injected link");
  }

  public InputStream getInputStream() throws IOException {
    throw new AssertionError("NativeAsk must use its injected link");
  }

  public OutputStream getOutputStream() throws IOException {
    throw new AssertionError("NativeAsk must use its injected link");
  }

  @Override public void close() throws IOException {
    throw new AssertionError("NativeAsk must use its injected link");
  }
}
