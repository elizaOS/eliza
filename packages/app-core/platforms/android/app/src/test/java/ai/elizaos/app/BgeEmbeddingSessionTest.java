/** Exercises real UTF-8 admission and artifact rejection without replacing the native encoder. */
package ai.elizaos.app;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import org.junit.Test;

public class BgeEmbeddingSessionTest {
    @Test public void completeUtf8PreservesSupplementaryAndNul() {
        String input = "before\u0000after \uD83D\uDE00 café 漢字";
        assertEquals(input, new String(BgeEmbeddingSession.completeUtf8(input), StandardCharsets.UTF_8));
        assertArrayEquals(input.getBytes(StandardCharsets.UTF_8), BgeEmbeddingSession.completeUtf8(input));
    }
    @Test public void invalidUtf16CannotBecomeReplacementCharacters() {
        for (String input : new String[] {"prefix\uD800", "\uDC00suffix", "\uD800x"}) {
            assertEquals("EMBEDDING_INPUT_INVALID", assertThrows(BgeEmbeddingSession.Failure.class,
                () -> BgeEmbeddingSession.completeUtf8(input)).code);
        }
    }
    @Test public void absentCorruptAndAmbiguousArtifactsRejectBeforeNativeLoading() throws Exception {
        Path root = Files.createTempDirectory("eliza-bge-admission-");
        try {
            assertArtifactRejected(root.toString());
            Path text = Files.createDirectory(root.resolve("text"));
            Files.writeString(text.resolve(BgeEmbeddingSession.MODEL), "not the canonical encoder");
            assertArtifactRejected(root.toString());
            Files.writeString(text.resolve("chat.gguf"), "chat weights");
            assertArtifactRejected(root.toString());
            Files.delete(text.resolve("chat.gguf"));
            Path nested = Files.createDirectory(text.resolve("aaa"));
            Files.writeString(nested.resolve("chat.gguf"), "native recursive picker candidate");
            assertArtifactRejected(root.toString());
            assertArtifactRejected(root + "\u0000suffix");
            assertArtifactRejected("");
        } finally {
            try (var files = Files.walk(root)) {
                for (Path file : files.sorted(Comparator.reverseOrder()).toList()) Files.delete(file);
            }
        }
    }
    private static void assertArtifactRejected(String path) {
        assertEquals("EMBEDDING_ARTIFACT_INVALID", assertThrows(BgeEmbeddingSession.Failure.class,
            () -> BgeEmbeddingSession.verifyBundle(path)).code);
    }
}
