import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("native reviewed passage preflights all chunks, emits bounded PCM and wipes cancelled audio", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-passage-"));
  try {
    fs.writeFileSync(
      path.join(dir, "PassageHarness.java"),
      `
import ai.eliza.speech.SpeechPassage;import java.util.*;import java.nio.*;import java.util.concurrent.atomic.*;
public class PassageHarness{
 static void check(boolean x){if(!x)throw new AssertionError();}static void fails(Runnable run){try{run.run();throw new AssertionError("Expected rejection");}catch(IllegalArgumentException|IllegalStateException expected){}}
 public static void main(String[] args){String text="Reviewed words. ".repeat(70);var chunks=SpeechPassage.plan(text);check(chunks.size()>1&&chunks.stream().allMatch(s->s.length()<=300));check(String.join(" ",chunks).equals(text.trim()));AtomicInteger validated=new AtomicInteger(),generated=new AtomicInteger();List<float[]> owned=new ArrayList<>();byte[] wav=SpeechPassage.synthesize(text,s->validated.incrementAndGet(),s->{check(validated.get()==chunks.size());generated.incrementAndGet();float[] samples={.5f,-.5f};owned.add(samples);return new SpeechPassage.Pcm(samples,16000);},()->false);check(generated.get()==chunks.size());check(wav.length==44+chunks.size()*4);check(ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).getInt(40)==chunks.size()*4);check(owned.stream().allMatch(a->a[0]==0&&a[1]==0));
 generated.set(0);fails(()->SpeechPassage.synthesize(text+" BAD",s->{if(s.contains("BAD"))throw new IllegalArgumentException();},s->{generated.incrementAndGet();return null;},()->false));check(generated.get()==0);
 AtomicBoolean cancelled=new AtomicBoolean();float[] samples={.5f};fails(()->SpeechPassage.synthesize("Reviewed text",s->{},s->{cancelled.set(true);return new SpeechPassage.Pcm(samples,16000);},cancelled::get));check(samples[0]==0);
 fails(()->SpeechPassage.plan("x".repeat(301)));fails(()->SpeechPassage.plan("x".repeat(5001)));fails(()->SpeechPassage.plan("bad\\0text"));
 float[] bad={Float.NaN};fails(()->SpeechPassage.synthesize("text",s->{},s->new SpeechPassage.Pcm(bad,16000),()->false));check(bad[0]==0);
 AtomicInteger rates=new AtomicInteger();fails(()->SpeechPassage.synthesize(text,s->{},s->new SpeechPassage.Pcm(new float[]{.5f},rates.incrementAndGet()==1?16000:22050),()->false));
 float[] huge=new float[16*1024*1024+1];fails(()->SpeechPassage.synthesize("text",s->{},s->new SpeechPassage.Pcm(huge,16000),()->false));
 System.out.println("PASS whole-passage preflight and audio bounds");}
}`,
    );
    const home =
      process.env.JAVA_HOME ||
      (process.platform === "darwin"
        ? "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
        : "");
    const bin = (name) => (home ? path.join(home, "bin", name) : name);
    execFileSync(
      bin("javac"),
      [
        "--release",
        "11",
        "-d",
        dir,
        fileURLToPath(
          new URL(
            "../../platforms/android/local-speech/src/main/java/ai/eliza/speech/SpeechPassage.java",
            import.meta.url,
          ),
        ),
        path.join(dir, "PassageHarness.java"),
      ],
      { stdio: "pipe", timeout: 60000 },
    );
    assert.match(
      execFileSync(bin("java"), ["-cp", dir, "PassageHarness"], {
        encoding: "utf8",
        timeout: 60000,
      }),
      /^PASS/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
