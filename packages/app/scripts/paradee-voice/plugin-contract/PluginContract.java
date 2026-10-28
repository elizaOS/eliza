package ai.eliza.voice;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/** Compares the public Java word normalization with the host's wer.ts. */
final class PluginContract {
    private PluginContract() {}

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line; (line = in.readLine()) != null; ) System.out.println(String.join(" ", Wer.normalize(line)));
    }
}
