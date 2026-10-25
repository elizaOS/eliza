package ai.eliza.voicequalify;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Same normalization and word error count as
 * packages/app/scripts/voice-quality/wer.ts, so host and device gates agree.
 */
final class Wer {
    /** Gate thresholds; must equal fixtures.json (checked by fixtures.test.ts). */
    static final double TTS_ROUND_TRIP_MAX_WER = 0.08;
    static final double ASR_MAX_WER = 0.06;

    private static final Map<String, Integer> UNITS = new HashMap<>();
    private static final Map<String, Integer> TENS = new HashMap<>();
    private static final Map<String, Long> SCALES = new HashMap<>();

    static {
        String[] units = {"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
                "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
                "eighteen", "nineteen"};
        for (int i = 0; i < units.length; i++) UNITS.put(units[i], i);
        UNITS.put("oh", 0);
        String[] tens = {"twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"};
        for (int i = 0; i < tens.length; i++) TENS.put(tens[i], 20 + i * 10);
        SCALES.put("thousand", 1_000L);
        SCALES.put("million", 1_000_000L);
        SCALES.put("billion", 1_000_000_000L);
    }

    private Wer() {}

    private static boolean isNumberWord(String w) {
        return UNITS.containsKey(w) || TENS.containsKey(w) || SCALES.containsKey(w) || w.equals("hundred");
    }

    private static Integer pairValue(List<String> words) {
        if (words.size() == 1) {
            String w = words.get(0);
            if (UNITS.containsKey(w)) return UNITS.get(w);
            if (TENS.containsKey(w)) return TENS.get(w);
            return null;
        }
        if (words.size() == 2 && TENS.containsKey(words.get(0)) && UNITS.containsKey(words.get(1))) {
            int u = UNITS.get(words.get(1));
            if (u > 0 && u < 10) return TENS.get(words.get(0)) + u;
        }
        return null;
    }

    static Long parseNumberWords(List<String> words) {
        if (words.isEmpty()) return null;
        boolean hasScale = false;
        for (String w : words) if (SCALES.containsKey(w) || w.equals("hundred")) hasScale = true;
        if (!hasScale) {
            for (int split = 1; split < words.size(); split++) {
                Integer head = pairValue(words.subList(0, split));
                Integer tail = pairValue(words.subList(split, words.size()));
                if (head != null && tail != null && head >= 10 && tail >= 10) return head * 100L + tail;
            }
        }
        if (words.contains("oh")) {
            if (words.size() == 3 && words.get(1).equals("oh")) {
                Integer head = pairValue(words.subList(0, 1));
                Integer tail = pairValue(words.subList(2, 3));
                if (head != null && tail != null && head >= 10 && tail < 10) return head * 100L + tail;
            }
            return null;
        }
        long total = 0;
        long current = 0;
        String last = "none";
        for (String w : words) {
            if (UNITS.containsKey(w)) {
                int v = UNITS.get(w);
                String kind = v < 10 ? "unit" : "teen";
                if (last.equals("unit") || last.equals("teen")) return null;
                if (last.equals("tens") && kind.equals("teen")) return null;
                current += v;
                last = kind;
            } else if (TENS.containsKey(w)) {
                if (last.equals("unit") || last.equals("teen") || last.equals("tens")) return null;
                current += TENS.get(w);
                last = "tens";
            } else if (w.equals("hundred")) {
                if (last.equals("hundred")) return null;
                if (current % 100 == 0 && current > 0) return null;
                current = (current == 0 ? 1 : current) * 100;
                last = "hundred";
            } else if (SCALES.containsKey(w)) {
                if (last.equals("scale")) return null;
                total += (current == 0 ? 1 : current) * SCALES.get(w);
                current = 0;
                last = "scale";
            } else {
                return null;
            }
        }
        return total + current;
    }

    private static List<String> numbersToDigits(List<String> words) {
        List<String> out = new ArrayList<>();
        int i = 0;
        while (i < words.size()) {
            if (!isNumberWord(words.get(i)) || words.get(i).equals("oh")) {
                out.add(words.get(i++));
                continue;
            }
            int j = i;
            while (j < words.size() && (isNumberWord(words.get(j))
                    || (words.get(j).equals("and") && j + 1 < words.size()
                        && isNumberWord(words.get(j + 1)) && words.get(j - 1).equals("hundred")))) {
                j++;
            }
            int end = j;
            Long value = null;
            while (end > i) {
                List<String> run = new ArrayList<>();
                for (String w : words.subList(i, end)) if (!w.equals("and")) run.add(w);
                value = parseNumberWords(run);
                if (value != null) break;
                end--;
            }
            if (value == null || end == i) {
                out.add(words.get(i++));
                continue;
            }
            out.add(String.valueOf(value));
            i = end;
        }
        return out;
    }

    static List<String> normalize(String text) {
        String folded = java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFKD)
                .replaceAll("[\\u0300-\\u036f]", "")
                .toLowerCase(Locale.ROOT)
                .replaceAll("[’'`]", "")
                .replaceAll("(\\d),(\\d{3})", "$1$2")
                .replace("%", " percent ")
                .replace("&", " and ")
                .replaceAll("[^a-z0-9]+", " ")
                .trim();
        List<String> words = new ArrayList<>();
        if (folded.isEmpty()) return words;
        for (String w : folded.split("\\s+")) words.add(w);
        return numbersToDigits(words);
    }

    /** {edits, reference words}. */
    static int[] wordErrors(String reference, String hypothesis) {
        List<String> ref = normalize(reference);
        List<String> hyp = normalize(hypothesis);
        int[] row = new int[hyp.size() + 1];
        for (int j = 0; j <= hyp.size(); j++) row[j] = j;
        for (int i = 1; i <= ref.size(); i++) {
            int previous = row[0];
            row[0] = i;
            for (int j = 1; j <= hyp.size(); j++) {
                int current = Math.min(Math.min(row[j] + 1, row[j - 1] + 1),
                        previous + (ref.get(i - 1).equals(hyp.get(j - 1)) ? 0 : 1));
                previous = row[j];
                row[j] = current;
            }
        }
        return new int[] {row[hyp.size()], ref.size()};
    }

    /** Windowed-sinc resampler (Hann, 16 zero crossings), as in wer.ts. */
    static float[] resample(float[] input, int from, int to) {
        if (from == to) return input;
        double ratio = from / (double) to;
        double cutoff = Math.min(1.0, to / (double) from) * 0.97;
        int half = 16;
        int count = (int) Math.floor(input.length / ratio);
        float[] out = new float[count];
        for (int n = 0; n < count; n++) {
            double center = n * ratio;
            int first = Math.max(0, (int) Math.ceil(center - half / cutoff));
            int last = Math.min(input.length - 1, (int) Math.floor(center + half / cutoff));
            double sum = 0;
            for (int k = first; k <= last; k++) {
                double x = (k - center) * cutoff;
                double sinc = x == 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
                double window = 0.5 + 0.5 * Math.cos(Math.PI * x / half);
                sum += input[k] * cutoff * sinc * window;
            }
            out[n] = (float) Math.max(-1, Math.min(1, sum));
        }
        return out;
    }
}
