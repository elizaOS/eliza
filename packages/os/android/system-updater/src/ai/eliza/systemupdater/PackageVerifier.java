// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.os.Build;
import android.os.RecoverySystem;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.util.Base64;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Validate the complete OTA and its signed A/B payload. Only a pre-apply scratch owner can extract. */
final class PackageVerifier {
    private static final int METADATA_LIMIT = 64 * 1024;
    private static final long MAX_PACKAGE = 12L * 1024 * 1024 * 1024;

    static VerifiedPayload verify(File ota, File outputDirectory, String expectedSha256,
            long expectedLength, String expectedFingerprint, long expectedTimestamp,
            String product, String device, String otaCertificateSha256, Path scratch)
            throws IOException, GeneralSecurityException {
        if (!expectedSha256.matches("[0-9a-f]{64}")
                || !otaCertificateSha256.matches("[0-9a-f]{64}")
                || expectedLength <= 0 || expectedLength > MAX_PACKAGE
                || !ota.isFile() || !ota.getCanonicalFile().equals(ota.getAbsoluteFile())
                || ota.length() != expectedLength || !digest(ota).equals(expectedSha256)) {
            throw new IOException("OTA identity or length differs");
        }
        File trust = enrolledTrustStore(outputDirectory, otaCertificateSha256);
        try {
            // Android verifies the complete package against the enrolled channel certificate.
            RecoverySystem.verifyPackage(ota, null, trust);
        } finally {
            Files.deleteIfExists(trust.toPath());
        }
        try (ZipFile zip = new ZipFile(ota)) {
            requireUnique(zip, "META-INF/com/android/metadata");
            requireUnique(zip, "payload_properties.txt");
            requireUnique(zip, "payload.bin");
            Map<String, String> metadata = properties(zip, "META-INF/com/android/metadata");
            if (!"AB".equals(metadata.get("ota-type"))
                    || !device.equals(metadata.get("pre-device"))
                    || !expectedFingerprint.equals(metadata.get("post-build"))
                    || !product.equals(productOf(expectedFingerprint))
                    || metadata.containsKey("ota-wipe")
                    || metadata.containsKey("ota-downgrade")) {
                throw new IOException("OTA is not a preserving update for this product");
            }
            String previous = metadata.get("pre-build");
            if (previous != null && !previous.equals(Build.FINGERPRINT)) {
                throw new IOException("Incremental OTA does not match the installed build");
            }
            long timestamp = positive(metadata.get("post-timestamp"));
            if (timestamp != expectedTimestamp || timestamp <= Build.TIME / 1000) {
                throw new IOException("OTA is not newer than the installed build");
            }
            String patch = metadata.get("post-security-patch-level");
            if (patch == null || !patch.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")
                    || patch.compareTo(Build.VERSION.SECURITY_PATCH) < 0) {
                throw new IOException("OTA lowers or omits the security patch level");
            }
            Map<String, String> payload = properties(zip, "payload_properties.txt");
            long size = positive(payload.get("FILE_SIZE"));
            long metadataSize = positive(payload.get("METADATA_SIZE"));
            String fileHash = payload.get("FILE_HASH"), metadataHash = payload.get("METADATA_HASH");
            if (size > MAX_PACKAGE || metadataSize > size
                    || !hashValue(fileHash) || !hashValue(metadataHash)) {
                throw new IOException("Invalid signed payload properties");
            }
            ZipEntry entry = zip.getEntry("payload.bin");
            if (entry.getSize() != size) throw new IOException("Payload size differs");
            if (!outputDirectory.isDirectory()
                    || !outputDirectory.getCanonicalFile().equals(outputDirectory.getAbsoluteFile())) {
                throw new IOException("Payload directory is unavailable");
            }
            File destination = new File(outputDirectory, expectedSha256 + ".payload");
            boolean retained = hasRetainedPayload(destination);
            if (!retained && scratch == null) throw new IOException("Held update payload is unavailable");
            requirePayloadSpace(outputDirectory, destination, size);
            if (retained) {
                if (!destination.isFile() || !destination.getCanonicalFile().equals(destination.getAbsoluteFile())
                        || destination.length() != size || !digestBase64(destination).equals(fileHash)) {
                    throw new IOException("Retained payload differs");
                }
            } else {
                Path partial = createExtractionScratch(scratch);
                extractPayload(zip, entry, partial, destination.toPath(), size, fileHash);
            }
            String[] headers = {"FILE_HASH=" + fileHash, "FILE_SIZE=" + size,
                    "METADATA_HASH=" + metadataHash, "METADATA_SIZE=" + metadataSize,
                    "SWITCH_SLOT_ON_REBOOT=1"};
            return new VerifiedPayload(destination, expectedFingerprint, expectedSha256,
                    timestamp, headers);
        }
    }

    static boolean hasRetainedPayload(File destination) throws IOException {
        BasicFileAttributes retained = attributes(destination.toPath());
        if (retained == null) return false;
        if (!retained.isRegularFile()) throw new IOException("Invalid retained payload path");
        return true;
    }

    /** The serial updater is the only writer. This namespace never supplies an engine descriptor. */
    static Path reclaimExtractionScratch(Path directory) throws IOException {
        Path slot = directory.resolve("pre-apply-payload-scratch-v1");
        Path marker = slot.resolve("owner");
        Path partial = slot.resolve("payload.partial");
        BasicFileAttributes slotState = attributes(slot);
        if (slotState == null) return partial;
        if (!slotState.isDirectory()) throw new IOException("Invalid pre-apply scratch directory");
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(slot)) {
            for (Path entry : entries) {
                if (!entry.equals(marker) && !entry.equals(partial)) {
                    throw new IOException("Unexpected pre-apply scratch entry");
                }
            }
        }
        BasicFileAttributes owner = attributes(marker);
        BasicFileAttributes bytes = attributes(partial);
        if ((owner != null && (!owner.isRegularFile() || owner.size() != 0))
                || (bytes != null && (owner == null || !bytes.isRegularFile()))) {
            throw new IOException("Unrecognized pre-apply scratch ownership");
        }
        if (bytes != null) Files.delete(partial);
        return partial;
    }

    static Path createExtractionScratch(Path partial) throws IOException {
        Path slot = partial.getParent();
        Path marker = slot.resolve("owner");
        if (attributes(slot) == null) {
            try { Os.mkdir(slot.toString(), 0777); }
            catch (ErrnoException failure) { throw scratchFailure(failure); }
        }
        if (attributes(marker) == null) createScratchFile(marker);
        // Persist the reservation before any payload bytes can exist under it.
        forceScratchDirectory(slot.getParent());
        forceScratchDirectory(slot);
        createScratchFile(partial);
        return partial;
    }

    private static void createScratchFile(Path path) throws IOException {
        new ScratchFile(path, OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL, 0666).close();
    }

    private static void forceScratchDirectory(Path path) throws IOException {
        try (ScratchFile directory = new ScratchFile(path, OsConstants.O_RDONLY, 0)) {
            directory.force();
        }
    }

    private static void forceDirectory(Path path) throws IOException {
        try (FileChannel directory = FileChannel.open(path, StandardOpenOption.READ)) {
            directory.force(true);
        }
    }

    // NIO may turn a local errno into a generic IOException. Keep the numeric error
    // at the operations that allocate, write or sync the owned pre-promotion scratch.
    private static IOException scratchFailure(ErrnoException failure) {
        return failure.errno == OsConstants.ENOSPC || failure.errno == OsConstants.EDQUOT
                ? new StorageDeferred(failure) : new IOException(failure);
    }

    private static void checkScratchInterrupted() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("OTA verification cancelled");
    }

    private static final class ScratchFile implements AutoCloseable {
        private final FileDescriptor descriptor;

        ScratchFile(Path path, int flags, int mode) throws IOException {
            try { descriptor = Os.open(path.toString(), flags | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, mode); }
            catch (ErrnoException failure) { throw scratchFailure(failure); }
        }

        void write(byte[] buffer, int count) throws IOException {
            int offset = 0;
            while (offset < count) {
                checkScratchInterrupted();
                int written;
                try { written = Os.write(descriptor, buffer, offset, count - offset); }
                catch (ErrnoException failure) { throw scratchFailure(failure); }
                if (written <= 0) throw new IOException("Scratch write made no progress");
                offset += written;
            }
        }

        void force() throws IOException {
            checkScratchInterrupted();
            try { Os.fsync(descriptor); }
            catch (ErrnoException failure) { throw scratchFailure(failure); }
        }

        @Override public void close() throws IOException {
            try { Os.close(descriptor); }
            catch (ErrnoException failure) { throw new IOException(failure); }
        }
    }

    private static BasicFileAttributes attributes(Path path) throws IOException {
        try { return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
        catch (NoSuchFileException absent) { return null; }
    }

    static void extractPayload(ZipFile zip, ZipEntry entry, Path partial, Path destination,
            long size, String fileHash) throws IOException, GeneralSecurityException {
        try {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            long copied = 0;
            try (InputStream input = zip.getInputStream(entry);
                    ScratchFile file = new ScratchFile(partial, OsConstants.O_WRONLY, 0)) {
                byte[] buffer = new byte[1024 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    checkScratchInterrupted();
                    copied += count;
                    if (copied > size) throw new IOException("Payload exceeds signed length");
                    file.write(buffer, count); hash.update(buffer, 0, count);
                }
                file.force();
            }
            if (copied != size || !Base64.getEncoder().encodeToString(hash.digest()).equals(fileHash)) {
                throw new IOException("Payload hash differs");
            }
            // A native write or sync can return after the Java task was cancelled.
            checkScratchInterrupted();
            Files.move(partial, destination, StandardCopyOption.ATOMIC_MOVE);
            if (!partial.getParent().equals(destination.getParent())) {
                // Both entries must be durable before the runner records a verified payload.
                forceDirectory(destination.getParent());
                forceDirectory(partial.getParent());
            }
        } finally {
            Files.deleteIfExists(partial);
        }
    }

    static final class StorageDeferred extends IOException {
        StorageDeferred() { this(null); }
        StorageDeferred(Throwable cause) { super("Insufficient space to verify the update payload", cause); }
    }

    static void requirePayloadSpace(File outputDirectory, File destination, long size)
            throws StorageDeferred {
        long requiredSpace = (destination.exists() ? 0 : size) + 2L * 1024 * 1024 * 1024;
        if (outputDirectory.getUsableSpace() < requiredSpace) throw new StorageDeferred();
    }

    private static File enrolledTrustStore(File directory, String expected) throws IOException, GeneralSecurityException {
        if (!directory.isDirectory() || !directory.getCanonicalFile().equals(directory.getAbsoluteFile())) {
            throw new IOException("Update trust directory is unavailable");
        }
        byte[] enrolled = null;
        try (ZipFile trust = new ZipFile("/system/etc/security/otacerts.zip")) {
            Enumeration<? extends ZipEntry> entries = trust.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) continue;
                try (InputStream input = trust.getInputStream(entry)) {
                    byte[] encoded = CertificateFactory.getInstance("X.509").generateCertificate(input).getEncoded();
                    if (hex(MessageDigest.getInstance("SHA-256").digest(encoded)).equals(expected)) {
                        enrolled = encoded;
                    }
                }
            }
        }
        if (enrolled == null) throw new GeneralSecurityException("Image has no enrolled OTA certificate");
        File selected = File.createTempFile("enrolled-ota-", ".zip", directory);
        try (FileOutputStream file = new FileOutputStream(selected);
                ZipOutputStream zip = new ZipOutputStream(file)) {
            zip.putNextEntry(new ZipEntry("enrolled.x509.pem"));
            zip.write(enrolled);
            zip.closeEntry();
            zip.finish();
            file.getFD().sync();
        } catch (IOException failure) {
            Files.deleteIfExists(selected.toPath());
            throw failure;
        }
        return selected;
    }

    private static void requireUnique(ZipFile zip, String name) throws IOException {
        int count = 0;
        Enumeration<? extends ZipEntry> entries = zip.entries();
        while (entries.hasMoreElements()) if (name.equals(entries.nextElement().getName())) count++;
        if (count != 1) throw new IOException("Missing or duplicate OTA entry");
    }

    private static Map<String, String> properties(ZipFile zip, String name) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (InputStream input = zip.getInputStream(zip.getEntry(name))) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > METADATA_LIMIT) throw new IOException("OTA metadata exceeds bound");
                output.write(buffer, 0, count);
            }
        }
        Map<String, String> values = new HashMap<>();
        for (String line : output.toString(StandardCharsets.UTF_8).split("\\r?\\n")) {
            if (line.isEmpty()) continue;
            int separator = line.indexOf('=');
            if (separator <= 0 || values.put(line.substring(0, separator), line.substring(separator + 1)) != null) {
                throw new IOException("Invalid or duplicate OTA metadata key");
            }
        }
        return values;
    }

    private static String productOf(String fingerprint) throws IOException {
        String[] parts = fingerprint.split("/", 3);
        if (parts.length != 3 || parts[1].isEmpty()) throw new IOException("Invalid build fingerprint");
        return parts[1];
    }

    private static boolean hashValue(String value) {
        try { return value != null && Base64.getDecoder().decode(value).length == 32; }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private static long positive(String value) throws IOException {
        if (value == null || !value.matches("[1-9][0-9]{0,18}")) throw new IOException("Invalid OTA size or time");
        try { return Long.parseLong(value); }
        catch (NumberFormatException invalid) { throw new IOException("OTA size or time overflow"); }
    }

    private static String digest(File file) throws IOException, GeneralSecurityException {
        return hex(hash(file));
    }

    private static String digestBase64(File file) throws IOException, GeneralSecurityException {
        return Base64.getEncoder().encodeToString(hash(file));
    }

    private static byte[] hash(File file) throws IOException, GeneralSecurityException {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = Files.newInputStream(file.toPath())) {
            byte[] buffer = new byte[1024 * 1024]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("OTA verification cancelled");
                hash.update(buffer, 0, count);
            }
        }
        return hash.digest();
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
}
