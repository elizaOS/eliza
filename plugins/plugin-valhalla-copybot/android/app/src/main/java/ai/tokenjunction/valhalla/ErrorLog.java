package ai.tokenjunction.valhalla;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Local error lines. Wallet keys are not written here. */
final class ErrorLog {
    private final File file;

    ErrorLog(Context context) {
        file = new File(context.getFilesDir(), "phone-errors.log");
    }

    synchronized void add(String message) {
        String safe = message == null ? "unknown error" : message.replaceAll("(?i)(api[_-]?key|secret|seed|private key)\\s*[:=]\\s*\\S+", "$1=(hidden)");
        String line = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date()) + " " + safe + "\n";
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write(line.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return;
        }
        trim();
    }

    synchronized void clear() {
        if (file.exists() && !file.delete()) {
            add("The error log could not be deleted.");
        }
    }

    synchronized String text() {
        if (!file.exists()) return "No errors yet.";
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            long start = Math.max(0, in.length() - 12_000);
            in.seek(start);
            byte[] buf = new byte[(int) (in.length() - start)];
            in.readFully(buf);
            String text = new String(buf, StandardCharsets.UTF_8).trim();
            return text.isEmpty() ? "No errors yet." : text;
        } catch (Exception err) {
            return "The error log could not be read.";
        }
    }

    private void trim() {
        if (file.length() < 40_000) return;
        try (RandomAccessFile in = new RandomAccessFile(file, "rw")) {
            long start = Math.max(0, in.length() - 20_000);
            in.seek(start);
            byte[] buf = new byte[(int) (in.length() - start)];
            in.readFully(buf);
            in.setLength(0);
            in.write(buf);
        } catch (Exception ignored) {
            // The next line can still be shown on screen.
        }
    }
}
