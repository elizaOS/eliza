package ai.eliza.voice;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** The bounded speech-only v1 binary wire. No URL, account or arbitrary control payload. */
final class CloudSpeechWire {
 static final int RATE=16000, MAX_UPLINK=3200, MAX_DOWNLINK=65536;
 /** One relay window (60 s) plus clock slack: the furthest end a mint or a renewal may name. */
 static final long MAX_WINDOW_MS=65000;
 /** The mint's offer to renew windows for a hello that sends extend; older relays refuse that key. */
 static final String EXTEND_HEADER="X-Eliza-Speech-Extend", EXTEND_OFFER="1";
 private CloudSpeechWire(){}
 static boolean id(String value){return value!=null&&value.matches("[A-Za-z0-9_-]{1,64}");}
 static final class Audio {final String id;final byte[] pcm;Audio(String id,byte[] pcm){this.id=id;this.pcm=pcm;}}
 static Audio decode(byte[] frame){
  if(frame==null||frame.length<4||frame[0]!=1)throw new IllegalArgumentException("Invalid audio frame");
  int n=frame[1]&255, offset=2+n, size=frame.length-offset;
  if(n<1||n>64||size<2||size%2!=0||size>MAX_DOWNLINK)throw new IllegalArgumentException("Invalid audio frame");
  String id=new String(frame,2,n,StandardCharsets.US_ASCII);
  if(!id(id))throw new IllegalArgumentException("Invalid audio identity");
  return new Audio(id,Arrays.copyOfRange(frame,offset,frame.length));
 }
 static float[] floats(byte[] pcm){
  if(pcm==null||pcm.length==0||pcm.length%2!=0||pcm.length>MAX_DOWNLINK)throw new IllegalArgumentException("Invalid PCM");
  float[] out=new float[pcm.length/2];
  for(int i=0;i<out.length;i++)out[i]=(short)((pcm[i*2]&255)|(pcm[i*2+1]<<8))/32768f;
  return out;
 }
 static java.util.List<String> phrases(String text){
  if(text==null||text.trim().isEmpty()||text.length()>4096)throw new IllegalArgumentException("Invalid speech text");
  java.util.ArrayList<String> parts=new java.util.ArrayList<>();int start=0;
  while(start<text.length()){int end=Math.min(text.length(),start+1024);if(end<text.length()){int space=text.lastIndexOf(' ',end-1);if(space<start)throw new IllegalArgumentException("Speech word is too long");end=space+1;}parts.add(text.substring(start,end));start=end;}
  return parts;
 }
 /** An 'extended' frame's new end: later than the current one and within one window of now, or invalid. */
 static long renewal(String expiresAt,long current,long now){
  long next;try{next=java.time.Instant.parse(expiresAt).toEpochMilli();}catch(RuntimeException invalid){throw new IllegalArgumentException("Invalid renewal");}
  if(next<=current||next>now+MAX_WINDOW_MS)throw new IllegalArgumentException("Invalid renewal");
  return next;
 }
 static double peak(byte[] pcm,int size){double peak=0;for(int i=0;i+1<size;i+=2){int sample=(short)((pcm[i]&255)|(pcm[i+1]<<8));peak=Math.max(peak,Math.abs(sample)/32768.0);}return Math.min(1,peak);}
}
