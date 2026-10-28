package ai.eliza.voice;

import android.content.Context;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

/** Actual file installation with synthetic bytes; no inference or device qualification. */
public final class VoiceBundleAssetsTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    private static void rejected(Context context) throws Exception {
        try { VoiceBundleAssets.install(context); throw new AssertionError("invalid input accepted"); }
        catch (java.io.IOException expected) {}
    }
    private static JSONObject manifest(Path assets, String content) throws Exception {
        JSONArray files = new JSONArray();
        for (String name : new String[]{"tts/paradee/model.gguf", "tts/paradee/lexicon.lex", "asr/model.gguf", "vad/model.gguf"}) {
            Path file = assets.resolve(VoiceBundleAssets.ASSET_ROOT).resolve(name);
            Files.createDirectories(file.getParent()); Files.writeString(file, content, StandardCharsets.UTF_8);
            files.put(new JSONObject().put("path", name).put("bytes", Files.size(file)).put("sha256", VoiceBundleAssets.sha256(file.toFile())));
        }
        JSONObject manifest = new JSONObject().put("format", "eliza-paradee-voice-v1")
            .put("model", "tts/paradee/model.gguf").put("lexicon", "tts/paradee/lexicon.lex").put("files", files);
        Files.writeString(assets.resolve(VoiceBundleAssets.ASSET_ROOT).resolve("manifest.json"), manifest.toString());
        return manifest;
    }
    public static void main(String[] args) throws Exception {
        Path temp = Path.of(args[0]), assets = temp.resolve("assets"), files = temp.resolve("private");
        Files.createDirectories(files);
        Context context = new Context(assets.toFile(), files.toFile());
        check(!VoiceBundleAssets.isPackaged(context), "absent bundle must stay absent");
        manifest(assets, "first model bytes");
        check(VoiceBundleAssets.isPackaged(context), "present manifest");
        VoiceBundleAssets.Installation first = VoiceBundleAssets.install(context);
        check(first.root.equals(files.resolve("paradee-voice-v1").toFile()), "legacy storage identity");
        check(Files.readString(first.model.toPath()).equals("first model bytes"), "installed model bytes");
        check(first.espeakDir == null, "optional eSpeak path");
        long before = first.model.lastModified();
        VoiceBundleAssets.install(context);
        check(first.model.lastModified() == before, "unchanged installation must not copy again");
        Files.writeString(first.model.toPath(), "short");
        VoiceBundleAssets.install(context);
        check(Files.readString(first.model.toPath()).equals("first model bytes"), "resized file repaired");
        context.info.metaData.put(VoiceBundleAssets.DIRECTORY_METADATA, "eliza-1/bundle");
        VoiceBundleAssets.Installation eliza = VoiceBundleAssets.install(context);
        check(eliza.root.equals(files.resolve("eliza-1/bundle").toFile()), "Eliza host directory");
        check(Arrays.equals(Files.readAllBytes(eliza.model.toPath()), Files.readAllBytes(first.model.toPath())), "same model in both host directories");
        for (Object bad : new Object[]{"", ".", "../outside", "tts/../outside", "/tmp/outside", true}) {
            context.info.metaData.put(VoiceBundleAssets.DIRECTORY_METADATA, bad); rejected(context);
        }
        context.info.metaData.put(VoiceBundleAssets.DIRECTORY_METADATA, "eliza-1/bundle");
        JSONObject broken = manifest(assets, "new model bytes");
        broken.getJSONArray("files").getJSONObject(0).put("sha256", "0".repeat(64));
        Files.writeString(assets.resolve(VoiceBundleAssets.ASSET_ROOT).resolve("manifest.json"), broken.toString());
        rejected(context);
        check(Files.readString(eliza.model.toPath()).equals("first model bytes"), "failed copy retains installed model");
        manifest(assets, "new model bytes");
        VoiceBundleAssets.install(context);
        check(Files.readString(eliza.model.toPath()).equals("new model bytes"), "new manifest installs new bytes");
        try { Class.forName("ai.eliza.voice.VoiceNative"); throw new AssertionError("installer required a JNI owner"); }
        catch (ClassNotFoundException expected) {}
        System.out.println("PASS shared voice asset installation, storage identity, repair and failed-copy preservation without JNI");
    }
}
