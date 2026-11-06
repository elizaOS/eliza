package android.os;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Test double: a pipe whose read end keeps what the write end wrote, so a scripted recognition
 * service sees the audio as it arrives. A write after the read end closed fails, as on Android.
 * {@link #stall} makes the read end stop reading, so a write waits until it closes.
 */
public class ParcelFileDescriptor implements Closeable {
    private final ParcelFileDescriptor peer;
    private final ByteArrayOutputStream data;
    private volatile boolean closed;
    private volatile boolean writeEnded;
    private volatile boolean stalled;

    private ParcelFileDescriptor(ParcelFileDescriptor peer, ByteArrayOutputStream data) {
        this.peer = peer;
        this.data = data;
    }

    public static ParcelFileDescriptor[] createPipe() throws IOException {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        ParcelFileDescriptor read = new ParcelFileDescriptor(null, data);
        return new ParcelFileDescriptor[] {read, new ParcelFileDescriptor(read, data)};
    }

    /** Read end: every byte written so far. */
    public byte[] received() {
        synchronized (data) {
            return data.toByteArray();
        }
    }

    /** Read end: the write end closed (end of the audio). */
    public boolean ended() {
        return writeEnded;
    }

    /** Read end: stops reading, as a recognition service that hangs; a write then waits until close. */
    public void stall() {
        stalled = true;
    }

    public boolean isClosed() {
        return closed;
    }

    @Override
    public void close() throws IOException {
        closed = true;
    }

    public static class AutoCloseOutputStream extends OutputStream {
        private final ParcelFileDescriptor write;

        public AutoCloseOutputStream(ParcelFileDescriptor descriptor) {
            write = descriptor;
        }

        @Override
        public void write(int value) throws IOException {
            write(new byte[] {(byte) value}, 0, 1);
        }

        @Override
        public void write(byte[] bytes, int offset, int length) throws IOException {
            while (write.peer.stalled && !write.peer.closed) {
                try {
                    Thread.sleep(1);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("interrupted");
                }
            }
            if (write.peer.closed) throw new IOException("read end closed");
            synchronized (write.data) {
                write.data.write(bytes, offset, length);
            }
        }

        @Override
        public void close() {
            write.closed = true;
            write.peer.writeEnded = true;
        }
    }
}
