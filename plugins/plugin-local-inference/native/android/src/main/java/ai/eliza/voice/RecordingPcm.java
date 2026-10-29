package ai.eliza.voice;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;

/**
 * Bounded conversion of a {@link LocalVoiceRecording} draft (mono 16 kHz AAC in MPEG-4) to PCM16
 * WAV for a recognizer: at most 60 s of audio, a 20 s decode deadline and cooperative
 * cancellation. Decoded chunks are zeroed after copying; the caller zeroes the returned bytes.
 */
public final class RecordingPcm {
 private RecordingPcm(){}
 public static byte[] decode(File file,BooleanSupplier cancelled)throws Exception{
  if(file==null||!file.isFile()||file.length()==0||file.length()>4*1024*1024)throw new IOException();
  MediaExtractor extractor=new MediaExtractor();MediaCodec codec=null;
  try{
   extractor.setDataSource(file.getAbsolutePath());int track=-1;MediaFormat format=null;
   for(int i=0;i<extractor.getTrackCount();i++){MediaFormat value=extractor.getTrackFormat(i);if("audio/mp4a-latm".equals(value.getString(MediaFormat.KEY_MIME))){if(track!=-1)throw new IOException();track=i;format=value;}}
   if(track<0||format==null||format.getInteger(MediaFormat.KEY_SAMPLE_RATE)!=16000||format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)!=1)throw new IOException();
   extractor.selectTrack(track);format.setInteger(MediaFormat.KEY_PCM_ENCODING,AudioFormat.ENCODING_PCM_16BIT);
   codec=MediaCodec.createDecoderByType("audio/mp4a-latm");codec.configure(format,null,null,0);codec.start();
   ByteArrayOutputStream pcm=new ByteArrayOutputStream();MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();boolean inputEnded=false,outputEnded=false,outputVerified=false;long deadline=SystemClock.elapsedRealtime()+20000;
   while(!outputEnded){
    if(cancelled.getAsBoolean()||SystemClock.elapsedRealtime()>deadline)throw new IOException();
    if(!inputEnded){int index=codec.dequeueInputBuffer(10000);if(index>=0){ByteBuffer input=codec.getInputBuffer(index);if(input==null)throw new IOException();int size=extractor.readSampleData(input,0);if(size<0){codec.queueInputBuffer(index,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);inputEnded=true;}else{codec.queueInputBuffer(index,0,size,extractor.getSampleTime(),0);extractor.advance();}}}
    int index=codec.dequeueOutputBuffer(info,10000);
    if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){MediaFormat output=codec.getOutputFormat();if(output.getInteger(MediaFormat.KEY_SAMPLE_RATE)!=16000||output.getInteger(MediaFormat.KEY_CHANNEL_COUNT)!=1||(output.containsKey(MediaFormat.KEY_PCM_ENCODING)&&output.getInteger(MediaFormat.KEY_PCM_ENCODING)!=AudioFormat.ENCODING_PCM_16BIT))throw new IOException();outputVerified=true;}
    else if(index>=0){try{if(info.size>0&&(info.flags&MediaCodec.BUFFER_FLAG_CODEC_CONFIG)==0){if(!outputVerified||info.size%2!=0||pcm.size()+info.size>60*32000)throw new IOException();ByteBuffer output=codec.getOutputBuffer(index);if(output==null)throw new IOException();output.position(info.offset);output.limit(info.offset+info.size);byte[] chunk=new byte[info.size];output.get(chunk);pcm.write(chunk);java.util.Arrays.fill(chunk,(byte)0);}outputEnded=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0;}finally{codec.releaseOutputBuffer(index,false);}}
   }
   if(pcm.size()==0||cancelled.getAsBoolean())throw new IOException();byte[] samples=pcm.toByteArray();ByteBuffer wav=ByteBuffer.allocate(44+samples.length).order(ByteOrder.LITTLE_ENDIAN);wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36+samples.length).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short)1).putShort((short)1).putInt(16000).putInt(32000).putShort((short)2).putShort((short)16).put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples.length).put(samples);java.util.Arrays.fill(samples,(byte)0);return wav.array();
  }finally{if(codec!=null){try{codec.stop();}catch(RuntimeException ignored){}codec.release();}extractor.release();}
 }
}
