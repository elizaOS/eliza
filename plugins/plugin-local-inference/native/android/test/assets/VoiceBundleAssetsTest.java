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
    /** Writes an APK stand-in that stores each named asset uncompressed at its offset. */
    private static Path apk(Path temp, String name, Path assets, Context context, Object... placed) throws Exception {
        Path apk = temp.resolve(name).toAbsolutePath();
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        context.getAssets().stored.clear();
        for (int i = 0; i < placed.length; i += 2) {
            String asset = VoiceBundleAssets.ASSET_ROOT + "/" + placed[i];
            long offset = (Long) placed[i + 1];
            while (bytes.size() < offset) bytes.write('j');
            bytes.write(Files.readAllBytes(assets.resolve(asset)));
            context.getAssets().stored.put(asset, new Object[]{apk.toString(), offset});
        }
        bytes.write("trailer".getBytes(StandardCharsets.UTF_8));
        Files.write(apk, bytes.toByteArray());
        return apk;
    }

    private static String region(Path apk, long offset, long length) {
        return VoiceBundleAssets.REGION_MAGIC + "\noffset=" + offset + "\nlength=" + length + "\npath=" + apk + "\n";
    }

    /** MODELS_IN_PLACE: region files for uncompressed, aligned model assets; copies for the rest. */
    private static void inPlace(Path temp, Path assets, Context context) throws Exception {
        context.info.metaData.put(VoiceBundleAssets.DIRECTORY_METADATA, "in-place");
        manifest(assets, "in-place model bytes");
        long length = "in-place model bytes".length();
        // asr model: aligned (in place); tts model: unaligned (copied); lexicon: not stored (compressed,
        // copied); vad model: aligned but not a loader that reads region files (copied).
        Path first = apk(temp, "first.apk", assets, context, "asr/model.gguf", 4096L + 16, "tts/paradee/model.gguf", 8200L + 4,
                "vad/model.gguf", 12288L);
        context.info.metaData.put(VoiceBundleAssets.MODELS_IN_PLACE_METADATA, true);
        VoiceBundleAssets.Installation one = VoiceBundleAssets.install(context);
        Path asr = one.root.toPath().resolve("asr/model.gguf");
        check(Files.readString(asr).equals(region(first, 4096 + 16, length)), "asr model is a region file");
        check(Files.readString(one.model.toPath()).equals("in-place model bytes"), "unaligned asset copied");
        check(Files.readString(one.lexicon.toPath()).equals("in-place model bytes"), "compressed asset copied");
        check(Files.readString(one.root.toPath().resolve("vad/model.gguf")).equals("in-place model bytes"), "vad copied");
        long before = asr.toFile().lastModified();
        Thread.sleep(20);
        VoiceBundleAssets.install(context);
        check(asr.toFile().lastModified() == before, "unchanged region file is not rewritten");
        // An app update moves the asset; the region file follows it.
        Path second = apk(temp, "second.apk", assets, context, "asr/model.gguf", 65536L);
        VoiceBundleAssets.install(context);
        check(Files.readString(asr).equals(region(second, 65536, length)), "region file follows the APK");
        // An update with the same manifest is not hashed again: junk bytes in the moved APK still link.
        Path moved = temp.resolve("moved.apk").toAbsolutePath();
        Files.write(moved, new byte[70000]);
        context.getAssets().stored.put(VoiceBundleAssets.ASSET_ROOT + "/asr/model.gguf", new Object[]{moved.toString(), 1024L});
        VoiceBundleAssets.install(context);
        check(Files.readString(asr).equals(region(moved, 1024, length)), "same manifest: region file rewritten without hashing");
        // Without a verified stamp the APK bytes must match the manifest.
        Path stamp = asr.getParent().getParent().resolve("installed-manifest.json");
        Files.delete(stamp);
        context.getAssets().stored.put(VoiceBundleAssets.ASSET_ROOT + "/asr/model.gguf", new Object[]{moved.toString(), 2048L});
        rejected(context);
        check(Files.readString(asr).equals(region(moved, 1024, length)), "failed check keeps the region file");
        // A changed manifest hashes again.
        manifest(assets, "in-place model bytes");
        Files.writeString(stamp, "older manifest");
        rejected(context);
        apk(temp, "second.apk", assets, context, "asr/model.gguf", 65536L);
        VoiceBundleAssets.install(context);
        check(Files.readString(asr).equals(region(second, 65536, length)), "changed manifest hashes and links");
        // Without the meta-data the model is copied again, replacing the region file.
        context.info.metaData.remove(VoiceBundleAssets.MODELS_IN_PLACE_METADATA);
        VoiceBundleAssets.install(context);
        check(Files.readString(asr).equals("in-place model bytes"), "copy replaces the region file");
        // A copy is replaced by a region file, which frees its storage.
        apk(temp, "third.apk", assets, context, "asr/model.gguf", 4096L);
        context.info.metaData.put(VoiceBundleAssets.MODELS_IN_PLACE_METADATA, true);
        VoiceBundleAssets.install(context);
        check(Files.readString(asr).startsWith(VoiceBundleAssets.REGION_MAGIC + "\n"), "region file replaces the copy");
        context.info.metaData.put(VoiceBundleAssets.MODELS_IN_PLACE_METADATA, "true");
        rejected(context);
        context.info.metaData.remove(VoiceBundleAssets.MODELS_IN_PLACE_METADATA);
        context.getAssets().stored.clear();
        check(VoiceBundleAssets.inPlaceEligible("asr/a.gguf") && VoiceBundleAssets.inPlaceEligible("tts/paradee/a.lex")
                && !VoiceBundleAssets.inPlaceEligible("vad/a.gguf")
                && !VoiceBundleAssets.inPlaceEligible("tts/paradee/espeak-ng-data/phontab"), "eligible paths");
    }

    public static void main(String[] args) throws Exception {
        Path temp = Path.of(args[0]), assets = temp.resolve("assets"), files = temp.resolve("private");
        Files.createDirectories(files);
        Context context = new Context(assets.toFile(), files.toFile());
        check(!VoiceBundleAssets.isPackaged(context), "absent bundle must stay absent");
        manifest(assets, "first model bytes");
        check(VoiceBundleAssets.isPackaged(context), "present manifest");
        // A status read before the first install: the languages come from the APK, nothing is copied.
        check(VoiceBundleAssets.packagedLanguages(context).equals(java.util.List.of("en")), "v1 speaks English");
        check(!Files.exists(files.resolve("paradee-voice-v1")), "reading the languages installs nothing");
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
        check(VoiceBundleAssets.install(context).voices.isEmpty(), "a v1 bundle has no extra voices");
        // v2 without the opt-in voices (the default build): English only.
        JSONObject english = manifest(assets, "v2 english bytes").put("format", "eliza-paradee-voice-v2");
        Files.writeString(assets.resolve(VoiceBundleAssets.ASSET_ROOT).resolve("manifest.json"), english.toString());
        check(VoiceBundleAssets.install(context).voices.isEmpty(), "a v2 bundle without voices has no extra voices");
        // v2: a second speech language in the same bundle.
        JSONObject v2 = manifest(assets, "v2 model bytes");
        Path spanish = assets.resolve(VoiceBundleAssets.ASSET_ROOT).resolve("tts/paradee/es.gguf");
        Files.writeString(spanish, "spanish bytes", StandardCharsets.UTF_8);
        v2.getJSONArray("files").put(new JSONObject().put("path", "tts/paradee/es.gguf").put("bytes", Files.size(spanish))
            .put("sha256", VoiceBundleAssets.sha256(spanish.toFile())));
        v2.put("format", "eliza-paradee-voice-v2").put("voices", new JSONObject().put("es", "tts/paradee/es.gguf"));
        Files.writeString(assets.resolve(VoiceBundleAssets.ASSET_ROOT).resolve("manifest.json"), v2.toString());
        VoiceBundleAssets.Installation two = VoiceBundleAssets.install(context);
        check(two.voices.keySet().equals(java.util.Collections.singleton("es")), "v2 voices");
        check(VoiceBundleAssets.packagedLanguages(context).equals(java.util.List.of("en", "es")), "v2 languages before install");
        check(Files.readString(two.voices.get("es").toPath()).equals("spanish bytes"), "installed Spanish model");
        for (Object[] bad : new Object[][]{{"es", "../outside.gguf"}, {"ES!", "tts/paradee/es.gguf"}}) {
            v2.put("voices", new JSONObject().put((String) bad[0], bad[1]));
            Files.writeString(assets.resolve(VoiceBundleAssets.ASSET_ROOT).resolve("manifest.json"), v2.toString());
            rejected(context);
            if ("ES!".equals(bad[0])) {
                try { VoiceBundleAssets.packagedLanguages(context); throw new AssertionError("invalid language listed"); }
                catch (java.io.IOException expected) {}
            }
        }
        inPlace(temp, assets, context);
        try { Class.forName("ai.eliza.voice.VoiceNative"); throw new AssertionError("installer required a JNI owner"); }
        catch (ClassNotFoundException expected) {}
        System.out.println("PASS shared voice asset installation, storage identity, repair, failed-copy preservation, v2 voices and in-place models without JNI");
    }
}
