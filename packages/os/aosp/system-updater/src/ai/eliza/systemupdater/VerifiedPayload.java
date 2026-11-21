// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.content.res.AssetFileDescriptor;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.IOException;

/** Constructed only by the package verifier. The engine receives a read-only file descriptor. */
final class VerifiedPayload {
    final File file;
    final UpdateAdmission.Release release;
    final String otaSha256;
    private final String[] headers;

    VerifiedPayload(File file, UpdateAdmission.Release release, String otaSha256, String[] headers) {
        this.file = file;
        this.release = release;
        this.otaSha256 = otaSha256;
        this.headers = headers.clone();
    }

    AssetFileDescriptor open() throws IOException {
        return new AssetFileDescriptor(ParcelFileDescriptor.open(file,
                ParcelFileDescriptor.MODE_READ_ONLY), 0, file.length());
    }

    String[] headers() { return headers.clone(); }
}
