package ai.elizaos.app;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class SecureStoreFrameInputTest {
    @Test public void fragmentedFramesKeepHeaderPayloadAndNextFrameSeparate() throws Exception {
        byte[] payload = "synthetic 🦊 私密".getBytes(StandardCharsets.UTF_8);
        byte[] wire = new byte[4 + payload.length + 1];
        wire[0] = (byte) payload.length;
        System.arraycopy(payload, 0, wire, 4, payload.length);
        wire[wire.length - 1] = 73;
        InputStream input = new ByteArrayInputStream(wire) {
            @Override public synchronized int read(byte[] target, int offset, int count) {
                return super.read(target, offset, Math.min(count, 1));
            }
        };
        assertArrayEquals(new byte[]{(byte) payload.length, 0, 0, 0}, SecureStoreFrameInput.readBounded(input, 4));
        assertArrayEquals(payload, SecureStoreFrameInput.readBounded(input, payload.length));
        assertEquals(73, input.read());
    }

    @Test public void eofAndTruncationRemainDistinguishable() throws Exception {
        assertEquals(0, SecureStoreFrameInput.readBounded(new ByteArrayInputStream(new byte[0]), 4).length);
        assertArrayEquals(new byte[]{1, 0}, SecureStoreFrameInput.readBounded(new ByteArrayInputStream(new byte[]{1, 0}), 4));
        assertArrayEquals(new byte[]{4, 5}, SecureStoreFrameInput.readBounded(new ByteArrayInputStream(new byte[]{4, 5}), 8));
    }

    @Test public void zeroBulkProgressConsumesSingleBytesIncludingZero() throws Exception {
        InputStream input = new ByteArrayInputStream(new byte[]{0, 1, 0, 2}) {
            @Override public synchronized int read(byte[] target, int offset, int count) { return 0; }
        };
        assertArrayEquals(new byte[]{0, 1, 0, 2}, SecureStoreFrameInput.readBounded(input, 5));
    }

    @Test public void invalidLengthsNeverReadAndMaximumIsAccepted() throws Exception {
        InputStream untouched = new InputStream() {
            @Override public int read() { throw new AssertionError("must not read"); }
        };
        assertThrows(IllegalArgumentException.class, () -> SecureStoreFrameInput.readBounded(untouched, -1));
        assertThrows(IllegalArgumentException.class, () -> SecureStoreFrameInput.readBounded(untouched, 4 * 1024 * 1024 + 1));
        assertEquals(0, SecureStoreFrameInput.readBounded(untouched, 0).length);
        assertEquals(0, SecureStoreFrameInput.readBounded(new ByteArrayInputStream(new byte[0]), 4 * 1024 * 1024).length);
    }

    @Test public void transportFailureIsPropagatedWithoutFabricatedFrame() {
        IOException failure = new IOException("synthetic disconnect");
        InputStream input = new InputStream() {
            @Override public int read() throws IOException { throw failure; }
        };
        assertSame(failure, assertThrows(IOException.class, () -> SecureStoreFrameInput.readBounded(input, 4)));
    }
}
