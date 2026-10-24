package ai.eliza.plugins.agent.updater.policy;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Properties;

/** One private file, replaced atomically after an fsync. Unreadable or
 * inconsistent state never blocks the updater: it is replaced by a fresh
 * ledger that raises a "policy-state-reset" alert, and every gate still
 * applies, so a reset can delay an activation but never permit one. */
public final class PolicyStore {
 static final int MAX_BYTES=16*1024;
 private final Path file;
 public PolicyStore(Path file){this.file=file;}
 public Path file(){return file;}

 public PolicyLedger load(){
  if(!Files.exists(file,LinkOption.NOFOLLOW_LINKS))return new PolicyLedger();
  try{
   if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS)||Files.size(file)>MAX_BYTES)throw new IOException("Unsafe policy ledger");
   byte[] bytes=Files.readAllBytes(file);
   Properties p=new Properties();p.load(new java.io.InputStreamReader(new ByteArrayInputStream(bytes),StandardCharsets.UTF_8.newDecoder()));
   return PolicyLedger.fromProperties(p);
  }catch(IOException|RuntimeException unreadable){return PolicyLedger.reset();}
 }

 public void save(PolicyLedger ledger)throws IOException {
  Path parent=file.toAbsolutePath().getParent();
  Files.createDirectories(parent);
  if(Files.exists(file,LinkOption.NOFOLLOW_LINKS)&&!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS))throw new IOException("Unsafe policy ledger");
  ByteArrayOutputStream out=new ByteArrayOutputStream();
  try(var writer=new java.io.OutputStreamWriter(out,StandardCharsets.UTF_8)){ledger.toProperties().store(writer,null);}
  Path temporary=parent.resolve(file.getFileName()+".tmp");
  Files.deleteIfExists(temporary);
  try(FileChannel channel=FileChannel.open(temporary,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){
   ByteBuffer buffer=ByteBuffer.wrap(out.toByteArray());while(buffer.hasRemaining())channel.write(buffer);channel.force(true);
  }
  try{Files.move(temporary,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
  catch(AtomicMoveNotSupportedException unsupported){Files.deleteIfExists(temporary);throw unsupported;}
  // Directory sync makes the rename durable on Linux; some hosts cannot open a directory.
  try(FileChannel directory=FileChannel.open(parent,StandardOpenOption.READ)){directory.force(true);}catch(IOException unsupported){/* best effort */}
 }
}
