// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.content.res.AssetFileDescriptor;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.IOException;

/** Constructed only by the package verifier. The engine receives a read-only file descriptor. */
final class VerifiedPayload {
    final File file;
    final String targetBuild;
    final String otaSha256;
    final long targetTimestamp;
    private final String[] headers;

    VerifiedPayload(File file, String targetBuild, String otaSha256,
            long targetTimestamp, String[] headers) {
        this.file = file;
        this.targetBuild = targetBuild;
        this.otaSha256 = otaSha256;
        this.targetTimestamp = targetTimestamp;
        this.headers = headers.clone();
    }

    AssetFileDescriptor open() throws IOException {
        return new AssetFileDescriptor(ParcelFileDescriptor.open(file,
                ParcelFileDescriptor.MODE_READ_ONLY), 0, file.length());
    }

    String[] headers() { return headers.clone(); }
}
