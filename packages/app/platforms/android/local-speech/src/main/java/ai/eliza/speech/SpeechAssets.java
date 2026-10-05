package ai.eliza.speech;
import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;
/** Installs only the APK's pinned speech bundle; accepts no URL or caller-selected path. */
public final class SpeechAssets {
 private SpeechAssets(){}
 public static synchronized File install(Context context)throws Exception {
  String manifest;try(InputStream in=context.getAssets().open("local-speech/v1/manifest.json")){ByteArrayOutputStream data=new ByteArrayOutputStream();byte[] block=new byte[8192];int count;while((count=in.read(block,0,Math.min(block.length,65537-data.size())))>0)data.write(block,0,count);byte[] bytes=data.toByteArray();if(bytes.length>65536)throw new IOException("Manifest too large");manifest=new String(bytes,StandardCharsets.UTF_8);}
  File directory=new File(context.getFilesDir(),"local-speech-v1");if(!directory.exists()&&!directory.mkdirs())throw new IOException("Speech storage unavailable");
  JSONArray entries=new JSONObject(manifest).getJSONArray("files");
  for(int i=0;i<entries.length();i++){
   JSONObject entry=entries.getJSONObject(i);String name=entry.getString("path");if(name.startsWith("/")||name.contains(".."))throw new IOException("Invalid bundle path");File target=new File(directory,name);if(!target.getCanonicalPath().startsWith(directory.getCanonicalPath()+File.separator))throw new IOException("Invalid bundle path");
   if(target.isFile()&&target.length()==entry.getLong("bytes")&&sha(target).equals(entry.getString("sha256")))continue;
   if(!target.getParentFile().isDirectory()&&!target.getParentFile().mkdirs())throw new IOException("Speech storage unavailable");File temp=new File(target.getPath()+".partial");
   try(InputStream in=context.getAssets().open("local-speech/v1/"+name);OutputStream out=new FileOutputStream(temp)){byte[] b=new byte[65536];long total=0;int n;while((n=in.read(b))!=-1){total+=n;if(total>entry.getLong("bytes"))throw new IOException("Asset exceeds manifest size");out.write(b,0,n);}}
   if(temp.length()!=entry.getLong("bytes")||!sha(temp).equals(entry.getString("sha256"))){temp.delete();throw new IOException("Speech asset checksum mismatch");}
   if(!temp.renameTo(target))throw new IOException("Speech asset installation failed");
  }
  File manifestFile=new File(directory,"manifest.json");try(OutputStream out=new FileOutputStream(manifestFile)){out.write(manifest.getBytes(StandardCharsets.UTF_8));}return directory;
 }
 private static String sha(File file)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}StringBuilder out=new StringBuilder();for(byte x:digest.digest())out.append(String.format(Locale.ROOT,"%02x",x&255));return out.toString();}
}
