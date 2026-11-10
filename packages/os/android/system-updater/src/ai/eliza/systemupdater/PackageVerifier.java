// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.os.Build;
import android.os.RecoverySystem;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.util.Base64;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Validate the complete OTA with Android's verifier, then extract its signed A/B payload. */
final class PackageVerifier {
    private static final int METADATA_LIMIT = 64 * 1024;
    private static final long MAX_PACKAGE = 12L * 1024 * 1024 * 1024;

    static VerifiedPayload verify(File ota, File outputDirectory, String expectedSha256,
            long expectedLength, String expectedFingerprint, long expectedTimestamp,
            String product, String device, String otaCertificateSha256)
            throws IOException, GeneralSecurityException {
        if (!expectedSha256.matches("[0-9a-f]{64}")
                || !otaCertificateSha256.matches("[0-9a-f]{64}")
                || expectedLength <= 0 || expectedLength > MAX_PACKAGE
                || !ota.isFile() || !ota.getCanonicalFile().equals(ota.getAbsoluteFile())
                || ota.length() != expectedLength || !digest(ota).equals(expectedSha256)) {
            throw new IOException("OTA identity or length differs");
        }
        verifyTrustStore(otaCertificateSha256);
        // Signature verification is Android's implementation over the complete downloaded zip.
        RecoverySystem.verifyPackage(ota, null, null);
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
            long requiredSpace = (destination.exists() ? 0 : size) + 2L * 1024 * 1024 * 1024;
            if (outputDirectory.getUsableSpace() < requiredSpace) {
                throw new IOException("Insufficient space to verify the update payload");
            }
            if (destination.exists()) {
                if (!destination.isFile() || !destination.getCanonicalFile().equals(destination.getAbsoluteFile())
                        || destination.length() != size || !digestBase64(destination).equals(fileHash)) {
                    throw new IOException("Retained payload differs");
                }
            } else {
                File partial = File.createTempFile("payload-", ".partial", outputDirectory);
                try {
                    MessageDigest hash = MessageDigest.getInstance("SHA-256");
                    long copied = 0;
                    try (InputStream input = zip.getInputStream(entry);
                            FileOutputStream output = new FileOutputStream(partial)) {
                        byte[] buffer = new byte[1024 * 1024];
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            if (Thread.currentThread().isInterrupted()) throw new IOException("OTA verification cancelled");
                            copied += count;
                            if (copied > size) throw new IOException("Payload exceeds signed length");
                            output.write(buffer, 0, count); hash.update(buffer, 0, count);
                        }
                        output.getFD().sync();
                    }
                    if (copied != size || !Base64.getEncoder().encodeToString(hash.digest()).equals(fileHash)) {
                        throw new IOException("Payload hash differs");
                    }
                    Files.move(partial.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE);
                } finally {
                    Files.deleteIfExists(partial.toPath());
                }
            }
            String[] headers = {"FILE_HASH=" + fileHash, "FILE_SIZE=" + size,
                    "METADATA_HASH=" + metadataHash, "METADATA_SIZE=" + metadataSize,
                    "SWITCH_SLOT_ON_REBOOT=1"};
            return new VerifiedPayload(destination, expectedFingerprint, expectedSha256,
                    timestamp, headers);
        }
    }

    private static void verifyTrustStore(String expected) throws IOException, GeneralSecurityException {
        int certificates = 0;
        try (ZipFile trust = new ZipFile("/system/etc/security/otacerts.zip")) {
            Enumeration<? extends ZipEntry> entries = trust.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) continue;
                try (InputStream input = trust.getInputStream(entry)) {
                    byte[] encoded = CertificateFactory.getInstance("X.509").generateCertificate(input).getEncoded();
                    if (!hex(MessageDigest.getInstance("SHA-256").digest(encoded)).equals(expected)) {
                        throw new GeneralSecurityException("Image OTA trust differs from the enrolled channel");
                    }
                    certificates++;
                }
            }
        }
        if (certificates == 0) throw new GeneralSecurityException("Image has no enrolled OTA certificate");
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
