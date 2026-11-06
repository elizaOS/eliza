package android.os;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;

/** Test double: a pipe whose write end keeps what is written. */
public class ParcelFileDescriptor implements Closeable {
    public static ParcelFileDescriptor[] createPipe() throws IOException {
        return new ParcelFileDescriptor[] {new ParcelFileDescriptor(), new ParcelFileDescriptor()};
    }

    @Override
    public void close() throws IOException {}

    public static class AutoCloseOutputStream extends ByteArrayOutputStream {
        public AutoCloseOutputStream(ParcelFileDescriptor descriptor) {}
    }
}
