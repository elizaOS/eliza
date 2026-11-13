package ai.eliza.voice;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * How many threads speech synthesis should use: the device's "big" cores. The native default is one
 * thread per core, and a thread on a little core holds the others back. Pure selection plus one
 * sysfs read; the host JVM test evaluates the selection directly.
 */
public final class SpeechCores {
 public static final int MIN_THREADS=2,MAX_THREADS=8;
 private SpeechCores(){}
 /** The thread count for this device, from each core's {@code cpuinfo_max_freq}. */
 public static int threads(){
  File[] cores=new File("/sys/devices/system/cpu").listFiles((dir,name)->name.matches("cpu\\d+"));
  long[] maximum=new long[cores==null?0:cores.length];
  for(int i=0;i<maximum.length;i++){
   try{maximum[i]=frequency(new String(Files.readAllBytes(new File(cores[i],"cpufreq/cpuinfo_max_freq").toPath()),StandardCharsets.US_ASCII));}
   catch(Exception unreadable){maximum[i]=0;}
  }
  return threads(maximum,Runtime.getRuntime().availableProcessors());
 }
 /** A sysfs frequency in kHz; 0 when it is not a positive number. */
 static long frequency(String text){
  try{long value=Long.parseLong(text.trim());return value>0?value:0;}catch(RuntimeException invalid){return 0;}
 }
 /**
  * Cores whose maximum frequency is within 20% of the fastest (0: unknown, ignored). Without any
  * known frequency, half the processors. Always {@link #MIN_THREADS}..{@link #MAX_THREADS}.
  */
 static int threads(long[] maximum,int processors){
  long fastest=0;for(long value:maximum)fastest=Math.max(fastest,value);
  int big=0;
  if(fastest>0)for(long value:maximum)if(value*5>=fastest*4)big++;
  if(big==0)big=Math.max(2,processors/2);
  return Math.max(MIN_THREADS,Math.min(MAX_THREADS,big));
 }
}
