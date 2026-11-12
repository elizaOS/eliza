package ai.eliza.voice;

/** JVM contract for the speech thread count; the sysfs read itself is device evidence. */
public final class SpeechCoresTest {
 private static void check(boolean ok,String what){if(!ok)throw new AssertionError(what);}
 public static void main(String[] args){
  check(SpeechCores.frequency("2914000\n")==2914000&&SpeechCores.frequency(" 1704000 ")==1704000,"a sysfs value is kHz with a newline");
  check(SpeechCores.frequency("")==0&&SpeechCores.frequency("fast")==0&&SpeechCores.frequency("-5")==0&&SpeechCores.frequency("0")==0,"anything else is unknown");
  long little=1704000,mid=2367000,prime=2914000;
  check(SpeechCores.threads(new long[]{little,little,little,little,mid,mid,mid,mid,prime},9)==5,"1+4+4: the prime core and the four within 20% of it");
  check(SpeechCores.threads(new long[]{little,little,little,little,mid,mid,prime,prime},8)==4,"2+2+4");
  check(SpeechCores.threads(new long[]{1800000,1800000,1800000,1800000,1800000,1800000,3000000,3000000},8)==2,"2+6");
  check(SpeechCores.threads(new long[]{little,little,little,little,little,little,little,prime},8)==2,"one big core still gets two threads");
  check(SpeechCores.threads(new long[]{prime,prime,prime,prime,prime,prime},6)==6,"equal cores are all big");
  check(SpeechCores.threads(new long[16],16)==8&&SpeechCores.threads(java.util.stream.LongStream.generate(()->prime).limit(16).toArray(),16)==8,"never more than eight");
  check(SpeechCores.threads(new long[]{0,0,prime,prime,prime,0},6)==3,"an unreadable core is not counted");
  check(SpeechCores.threads(new long[0],8)==4&&SpeechCores.threads(new long[]{0,0},6)==3,"without frequencies: half the processors");
  check(SpeechCores.threads(new long[0],1)==2&&SpeechCores.threads(new long[0],3)==2,"never fewer than two");
  int here=SpeechCores.threads();
  check(here>=SpeechCores.MIN_THREADS&&here<=SpeechCores.MAX_THREADS,"this machine: "+here);
  System.out.println("PASS speech cores");
 }
}
