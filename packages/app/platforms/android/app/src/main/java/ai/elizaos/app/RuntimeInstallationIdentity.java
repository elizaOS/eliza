/** Publishes the shared runtime identity before Bun starts on Android, where SELinux denies hard links. */
package ai.elizaos.app;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.UUID;

final class RuntimeInstallationIdentity {
    private RuntimeInstallationIdentity() {}

    // Every native launcher holds this process-shared lock until the complete
    // UUID has been atomically published and the directory entry made durable.
    // The JS reader retains its ownership, inode, permissions and UUID checks.
    static synchronized String ensure(Path stateDirectory) throws IOException {
        if (Files.isSymbolicLink(stateDirectory)
            || !Files.isDirectory(stateDirectory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Runtime identity requires a real state directory");
        }
        Path lock = stateDirectory.resolve(".runtime-installation-id.lock");
        try (FileChannel channel = FileChannel.open(lock,
                new java.util.HashSet<>(java.util.Arrays.asList(StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
             FileLock held = channel.lock()) {
            Path target = stateDirectory.resolve("runtime-installation-id");
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                return read(target);
            }
            String id = UUID.randomUUID().toString();
            Path temporary = Files.createTempFile(stateDirectory, ".runtime-installation-id.", ".tmp",
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            try {
                try (FileChannel candidate = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                    ByteBuffer bytes = ByteBuffer.wrap((id + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    while (bytes.hasRemaining()) candidate.write(bytes);
                    candidate.force(true);
                }
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE);
                try (FileChannel directory = FileChannel.open(stateDirectory, StandardOpenOption.READ)) {
                    directory.force(true);
                }
                return read(target);
            } finally {
                Files.deleteIfExists(temporary);
            }
        }
    }

    private static String read(Path target) throws IOException {
        if (Files.isSymbolicLink(target) || !Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Runtime identity must be a regular file");
        }
        String value = new String(Files.readAllBytes(target), java.nio.charset.StandardCharsets.UTF_8).trim();
        if (!value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) {
            throw new IOException("Existing runtime identity is invalid; refusing to replace it");
        }
        return value;
    }
}
