// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.util.AtomicFile;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** One process owns the store; corrupt or unexpected state is never reset to IDLE. */
final class JournalStore {
    private final AtomicFile file;

    JournalStore(File directory) { file = new AtomicFile(new File(directory, "journal.json")); }

    synchronized UpdateJournal read() throws IOException {
        try (FileInputStream input = file.openRead()) {
            byte[] data = input.readNBytes(16385);
            if (data.length > 16384) throw new IOException("Update journal exceeds bound");
            JSONObject value = new JSONObject(new String(data, StandardCharsets.UTF_8));
            if (value.length() != 6 || value.getInt("schema") != 1) {
                throw new IOException("Unknown update journal format");
            }
            return new UpdateJournal(UpdateJournal.Phase.valueOf(value.getString("phase")),
                    value.getString("source"), value.getString("target"),
                    value.getString("sha256"), value.getString("boot"));
        } catch (FileNotFoundException absent) {
            File directory = file.getBaseFile().getParentFile();
            String[] entries = directory.list();
            if (entries != null) {
                boolean journalExists = false;
                for (String name : entries) if (name.startsWith("journal.json")) journalExists = true;
                if (!journalExists) return UpdateJournal.idle();
            }
            throw absent;
        } catch (JSONException | IllegalArgumentException malformed) {
            throw new IOException("Update journal needs review", malformed);
        }
    }

    synchronized void write(UpdateJournal expected, UpdateJournal next) throws IOException {
        UpdateJournal current = read();
        if (!same(current, expected)) throw new IOException("Update state changed");
        final byte[] bytes;
        try {
            JSONObject value = new JSONObject();
            value.put("schema", 1); value.put("phase", next.phase.name());
            value.put("source", next.sourceBuild); value.put("target", next.targetBuild);
            value.put("sha256", next.packageSha256); value.put("boot", next.intentBoot);
            bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        } catch (JSONException invalid) { throw new IOException("Cannot encode update journal", invalid); }
        FileOutputStream output = null;
        try {
            output = file.startWrite(); output.write(bytes); output.getFD().sync();
            file.finishWrite(output); output = null;
        } finally { if (output != null) file.failWrite(output); }
        if (!same(read(), next)) throw new IOException("Update journal write is unconfirmed");
    }

    private static boolean same(UpdateJournal a, UpdateJournal b) {
        return a.phase == b.phase && a.sourceBuild.equals(b.sourceBuild)
                && a.targetBuild.equals(b.targetBuild) && a.packageSha256.equals(b.packageSha256)
                && a.intentBoot.equals(b.intentBoot);
    }
}
