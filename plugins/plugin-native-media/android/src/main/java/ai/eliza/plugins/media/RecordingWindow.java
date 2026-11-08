package ai.eliza.plugins.media;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.os.SystemClock;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/** A private, bounded AAC window of one explicitly selected retained recording. Never accepts paths. */
public final class RecordingWindow implements AutoCloseable {
 public final File file;
 public boolean empty;
 private final RecordingStore store;
 private final String audioId,ownerId,ownerField;
 private final long duration;
 private RecordingWindow(File file,RecordingStore store,String ownerField,String audioId,String ownerId,long duration){this.file=file;this.store=store;this.ownerField=ownerField;this.audioId=audioId;this.ownerId=ownerId;this.duration=duration;}
 public void check()throws Exception{
  JSONObject value=store.describe(audioId);
  if(!ownerId.equals(value.getString(ownerField))||!audioId.equals(value.getString("audioId"))||value.has("deletedAt")||value.getLong("durationMs")!=duration)throw new IOException("Recording changed");
 }
 public static RecordingWindow open(RecordingStore store,File cache,String ownerField,String recordingId,String owner,Long offset,Long duration,BooleanSupplier cancelled)throws Exception{
  String audioId=RecordingStore.id(recordingId),ownerId=RecordingStore.id(owner);
  if(ownerField==null||!ownerField.matches("[A-Za-z][A-Za-z0-9]{0,63}"))throw new IOException("Invalid recording owner field");
  if(offset==null||duration==null||duration<=0||offset<0||offset>=duration||offset%25000!=0||duration>9007199254740991L)throw new IOException("Invalid recording window");
  File temporary=File.createTempFile("eliza-recording-window-",".m4a",cache);
  RecordingWindow selected=new RecordingWindow(temporary,store,ownerField,audioId,ownerId,duration);
  try{
   selected.check();File original=store.playable(audioId);
   MediaExtractor extractor=new MediaExtractor();MediaMuxer muxer=null;boolean started=false;
   try{
    extractor.setDataSource(original.getAbsolutePath());int track=-1;MediaFormat format=null;
    for(int i=0;i<extractor.getTrackCount();i++){MediaFormat f=extractor.getTrackFormat(i);if("audio/mp4a-latm".equals(f.getString(MediaFormat.KEY_MIME))){if(track!=-1)throw new IOException("Ambiguous audio");track=i;format=f;}}
    if(track<0||format==null||format.getInteger(MediaFormat.KEY_SAMPLE_RATE)!=16000||format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)!=1)throw new IOException("Unsupported recording");
    extractor.selectTrack(track);long from=offset*1000,to=Math.min(duration,offset+25000)*1000;
    // Recorder wall-clock metadata can exceed encoded AAC duration by a final frame.
    if(format.containsKey(MediaFormat.KEY_DURATION)&&from>=format.getLong(MediaFormat.KEY_DURATION)){selected.empty=true;return selected;}
    extractor.seekTo(from,MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
    muxer=new MediaMuxer(temporary.getAbsolutePath(),MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);int output=muxer.addTrack(format);muxer.start();started=true;
    ByteBuffer buffer=ByteBuffer.allocate(256*1024);MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();long first=-1,deadline=SystemClock.elapsedRealtime()+20000;int samples=0;
    while(extractor.getSampleTime()>=0&&extractor.getSampleTime()<to){
     if(cancelled.getAsBoolean()||SystemClock.elapsedRealtime()>deadline)throw new IOException("Transcription cancelled");
     long time=extractor.getSampleTime();
     if(time>=from){buffer.clear();int size=extractor.readSampleData(buffer,0);if(size<=0||size>buffer.capacity())throw new IOException("Invalid audio sample");if(first<0)first=time;info.set(0,size,time-first,extractor.getSampleFlags());muxer.writeSampleData(output,buffer,info);samples++;}
     extractor.advance();
    }
    if(samples==0)throw new IOException("Empty recording window");
   }finally{extractor.release();if(muxer!=null){try{if(started)muxer.stop();}finally{muxer.release();}}}
   selected.check();if(cancelled.getAsBoolean())throw new IOException("Transcription cancelled");return selected;
  }catch(Exception failure){selected.close();throw failure;}
 }
 @Override public void close(){file.delete();}
}
