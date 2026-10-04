package ai.elizaos.app;

import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;

/** API 29-compatible bounded frame reads; the caller distinguishes EOF from truncation. */
final class SecureStoreFrameInput {
    private static final int MAX_FRAME = 4 * 1024 * 1024;

    private SecureStoreFrameInput() {}

    static byte[] readBounded(InputStream input, int length) throws IOException {
        if (length < 0 || length > MAX_FRAME) throw new IllegalArgumentException("Invalid frame length");
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length) {
            int count = input.read(bytes, offset, length - offset);
            if (count < 0) break;
            if (count == 0) {
                // Do not spin if a stream returns no bulk progress. A single read either
                // consumes one byte (including zero), reaches EOF, or propagates failure.
                int next = input.read();
                if (next < 0) break;
                bytes[offset++] = (byte) next;
            } else {
                offset += count;
            }
        }
        return offset == length ? bytes : Arrays.copyOf(bytes, offset);
    }
}
