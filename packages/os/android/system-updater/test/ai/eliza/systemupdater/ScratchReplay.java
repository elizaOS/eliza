// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Replay actual extraction on a private file tree across abrupt JVM termination. */
public final class ScratchReplay {
    private static final byte[] PAYLOAD = new byte[64 * 1024];
    static { for (int i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (byte) i; }

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        String mode = args[1];
        for (UpdateJournal.Phase phase : UpdateJournal.Phase.values()) {
            UpdateJournal journal = new UpdateJournal(phase, "source", "target", "a".repeat(64), "boot");
            check(journal.isUnapplied() == (phase == UpdateJournal.Phase.DOWNLOADING
                    || phase == UpdateJournal.Phase.VERIFIED), "Unexpected extraction ownership: " + phase);
        }
        if (mode.equals("refuse")) {
            try { PackageVerifier.reclaimExtractionScratch(root); }
            catch (IOException refused) { System.out.println("refused"); return; }
            throw new AssertionError("Unrecognized scratch accepted");
        }
        if (mode.equals("refuse-final")) {
            try { PackageVerifier.hasRetainedPayload(root.resolve("candidate.payload").toFile()); }
            catch (IOException refused) { System.out.println("refused final"); return; }
            throw new AssertionError("Unrecognized final pathname accepted");
        }
        Path zipPath = root.resolve("fixture.zip");
        if (!Files.exists(zipPath)) {
            try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(zipPath))) {
                zip.putNextEntry(new ZipEntry("payload.bin"));
                zip.write(PAYLOAD);
                zip.closeEntry();
            }
        }
        Path destination = root.resolve("candidate.payload");
        Path partial;
        if (mode.equals("legacy-cut")) {
            partial = java.io.File.createTempFile("payload-", ".partial", root.toFile()).toPath();
        } else {
            partial = PackageVerifier.reclaimExtractionScratch(root);
            check(!Files.exists(partial), "Stale scratch was not reclaimed");
            partial = PackageVerifier.createExtractionScratch(partial);
        }
        Path extraction = partial;
        try (ZipFile zip = new ZipFile(zipPath.toFile()) {
            @Override public InputStream getInputStream(ZipEntry entry) throws IOException {
                InputStream input = super.getInputStream(entry);
                if (mode.equals("publish")) return input;
                return new FilterInputStream(input) {
                    @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                        if (Files.size(extraction) > 0) Runtime.getRuntime().halt(73);
                        return super.read(buffer, offset, Math.min(length, 4096));
                    }
                };
            }
        }) {
            String digest = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(PAYLOAD));
            PackageVerifier.extractPayload(zip, zip.getEntry("payload.bin"), partial,
                    destination, PAYLOAD.length, digest);
        }
        check(mode.equals("publish"), "Expected abrupt termination before publish");
        check(MessageDigest.isEqual(PAYLOAD, Files.readAllBytes(destination)), "Published bytes differ");
        check(!Files.exists(partial), "Scratch remained after publish");
        System.out.println("published");
    }
}
