package ai.eliza.plugins.filesystem.browser;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SecureDirectoryStream;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributeView;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.json.JSONObject;

/**
 * Files browser operations on one storage volume with all-files access
 * (design/view-refresh-2026-11/PLAN.md section 4, spec files-browser). Paths are
 * volume-relative ("Download/a.pdf"); the root is "". Every write keeps both files on a
 * name clash ("a (1).pdf", never a replacement), and trash keeps the origin so Restore can
 * put an item back. Trash lives in the host’s hidden folder on the same volume so a
 * move to trash is a rename, with a ".nomedia" marker so trashed media leave the categories.
 */
public final class StorageBrowser {
 static final long RETENTION_MS=30L*86400000L;
 private final String trashFolder;
 public static final int BATCH_MAX=500,LIST_MAX=5000,WALK_MAX=20000;
 public final File root;
 public StorageBrowser(File root,String trashFolder){
  if(trashFolder==null||!trashFolder.matches("\\.[A-Za-z0-9_-]+"))throw new IllegalArgumentException("Invalid trash folder");
  this.root=root;this.trashFolder=trashFolder;
 }

 /** A volume-relative path that stays inside the volume and never names the trash itself. */
 public File resolve(String relative,boolean allowRoot)throws IOException{
  if(relative==null||relative.length()>1024)throw new IllegalArgumentException("Invalid path");
  String path=relative.replaceAll("^/+|/+$","");
  if(path.isEmpty()){if(allowRoot)return root;throw new IllegalArgumentException("Invalid path");}
  if(path.equals(trashFolder)||path.startsWith(trashFolder+"/"))throw new IllegalArgumentException("Invalid path");
  File file=root;
  for(String part:path.split("/")){
   file=new File(file,validName(part));
   if(isLink(file))throw new IllegalArgumentException("Invalid path");
  }
  String base=root.getCanonicalPath(),target=file.getCanonicalPath();
  if(!target.equals(base)&&!target.startsWith(base+File.separator))throw new IllegalArgumentException("Invalid path");
  return file;
 }
 static boolean isLink(File file){return Files.isSymbolicLink(file.toPath());}
 static boolean exists(File file){return Files.exists(file.toPath(),LinkOption.NOFOLLOW_LINKS);}
 static boolean isDirectory(File file){return Files.isDirectory(file.toPath(),LinkOption.NOFOLLOW_LINKS);}
 static String validName(String value){
  if(value==null)throw new IllegalArgumentException("Invalid name");String name=value.trim();
  if(name.isEmpty()||!name.equals(value)||name.length()>255||name.equals(".")||name.equals("..")||name.indexOf('/')>=0||name.indexOf('\\')>=0||name.chars().anyMatch(c->c<0x20||c==0x7f))throw new IllegalArgumentException("Invalid name");
  return name;
 }
 String relative(File file)throws IOException{String base=root.getCanonicalPath(),path=file.getCanonicalPath();return path.equals(base)?"":path.substring(base.length()+1).replace(File.separatorChar,'/');}

 /** Spec FreeName: the first "stem (n).ext" no sibling uses, compared case-insensitively. */
 static String freeName(String name,Set<String> taken,boolean directory){
  Set<String> used=new HashSet<>();for(String t:taken)used.add(t.toLowerCase(Locale.ROOT));
  if(!used.contains(name.toLowerCase(Locale.ROOT)))return name;
  int dot=directory?-1:name.lastIndexOf('.');
  String stem=dot>0?name.substring(0,dot):name,ext=dot>0?name.substring(dot):"";
  String base=stem.replaceAll(" \\(\\d+\\)$","");
  for(int n=1;n<10000;n++){String candidate=base+" ("+n+")"+ext;if(!used.contains(candidate.toLowerCase(Locale.ROOT)))return candidate;}
  throw new IllegalStateException("No free name");
 }
 static Set<String> names(File folder){Set<String> out=new HashSet<>();String[] list=folder.list();if(list!=null)for(String n:list)out.add(n);return out;}
 static File freeTarget(File folder,String name,boolean directory){return new File(folder,freeName(name,names(folder),directory));}

 public static final class Row{public final String path,name,mime;public final boolean directory;public final long size,modified;public final int children;
  Row(String path,String name,boolean directory,String mime,long size,long modified,int children){this.path=path;this.name=name;this.directory=directory;this.mime=mime;this.size=size;this.modified=modified;this.children=children;}}
 /** Visible children; hidden (dot) entries, including the trash, are not listed. */
 public List<Row> list(String path)throws IOException{
  File folder=resolve(path,true);if(!folder.isDirectory())throw new java.io.FileNotFoundException();
  File[] files=folder.listFiles();if(files==null)throw new SecurityException("Folder unreadable");
  List<Row> out=new ArrayList<>();String parent=relative(folder);
  for(File f:files){
   String name=f.getName();if(name.startsWith(".")||isLink(f))continue;
   boolean dir=f.isDirectory();int children=0;
   if(dir){String[] kids=f.list();if(kids!=null)for(String k:kids)if(!k.startsWith("."))children++;}
   out.add(new Row(parent.isEmpty()?name:parent+"/"+name,name,dir,dir?"":mime(name),dir?0:f.length(),f.lastModified(),children));
  }
  return out;
 }
 /** The files directly in `path`, newest first (the Downloads category); a missing folder has none. */
 List<Row> files(String path,int max)throws IOException{
  List<Row> rows,out=new ArrayList<>();
  try{rows=list(path);}catch(java.io.FileNotFoundException missing){return out;}
  rows.sort((a,b)->Long.compare(b.modified,a.modified));
  for(Row r:rows){if(out.size()>=max)break;if(!r.directory)out.add(r);}
  return out;
 }
 /** Folders for the agent's folder filter: a bounded walk under `under` (hidden folders and the
  * trash skipped) for folders whose name holds every word and whose time is in range, newest first. */
 public List<Row> folders(String under,String text,long from,long to,int max,int visitMax)throws IOException{
  File start=resolve(under==null?"":under,true);List<Row> out=new ArrayList<>();if(!start.isDirectory())return out;
  List<String> words=new ArrayList<>();if(text!=null)for(String w:text.toLowerCase(Locale.ROOT).split("[^\\p{L}\\p{N}]+"))if(!w.isEmpty())words.add(w);
  java.util.ArrayDeque<File> queue=new java.util.ArrayDeque<>();queue.add(start);int visited=0;
  while(!queue.isEmpty()&&visited++<visitMax){
   File[] kids=queue.removeFirst().listFiles();if(kids==null)continue;
   for(File kid:kids){
    String name=kid.getName();if(name.startsWith(".")||!isDirectory(kid))continue;
    queue.add(kid);
    long modified=kid.lastModified();String lower=name.toLowerCase(Locale.ROOT);boolean match=(from<=0||modified>=from)&&(to<=0||modified<=to);
    for(String w:words)if(!lower.contains(w)){match=false;break;}
    if(!match)continue;
    int children=0;String[] list=kid.list();if(list!=null)for(String k:list)if(!k.startsWith("."))children++;
    out.add(new Row(relative(kid),name,true,"",0,modified,children));
   }
  }
  out.sort((a,b)->Long.compare(b.modified,a.modified));
  return out.size()>max?new ArrayList<>(out.subList(0,max)):out;
 }
 public static String mime(String name){
  int dot=name.lastIndexOf('.');String ext=dot>0?name.substring(dot+1).toLowerCase(Locale.ROOT):"";
  String type=ext.isEmpty()?null:android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
  return type==null?"application/octet-stream":type;
 }

 /** Opaque token for the actual object read at review time, without exporting its filesystem key. */
 private static String reviewedIdentity(File file)throws IOException{
  BasicFileAttributes attributes;
  try{
   attributes=Files.readAttributes(file.toPath(),BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
  }catch(NoSuchFileException missing){return null;}
  Object key=attributes.fileKey();
  if(key==null||!(attributes.isRegularFile()||attributes.isDirectory()))return null;
  String identity=key+"\n"+attributes.creationTime()+"\n"+attributes.lastModifiedTime()+"\n"
   +attributes.size()+"\n"+attributes.isDirectory();
  try{
   byte[] digest=MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
   return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
  }catch(NoSuchAlgorithmException unavailable){throw new IOException("File identity unavailable",unavailable);}
 }
 public List<String> reviewedIdentities(List<String> paths)throws IOException{
  if(paths.isEmpty()||paths.size()>BATCH_MAX)throw new IllegalArgumentException("Invalid selection");
  List<String> identities=new ArrayList<>(paths.size());
  for(String path:paths)identities.add(reviewedIdentity(resolve(path,false)));
  return identities;
 }
 private static void checkReviewed(List<String> paths,List<String> reviewed){
  if(reviewed!=null&&(paths.isEmpty()||paths.size()>BATCH_MAX||reviewed.size()!=paths.size()
     ||reviewed.stream().anyMatch(token->token==null||!token.matches("[A-Za-z0-9_-]{43}"))))
   throw new IllegalArgumentException("Invalid reviewed file identities");
 }

 public static final class Outcome{public final String path,status,to;Outcome(String path,String status,String to){this.path=path;this.status=status;this.to=to;}}
 /** Move or copy each path into dest. A clash keeps both (spec MoveOne with FixConflict). */
 public List<Outcome> transfer(List<String> paths,String dest,boolean copy)throws IOException{
  return transfer(paths,dest,copy,null);
 }
 public List<Outcome> transfer(List<String> paths,String dest,boolean copy,List<String> reviewed)throws IOException{
  checkReviewed(paths,reviewed);
  File target=resolve(dest,true);if(!target.isDirectory())throw new java.io.FileNotFoundException("Destination missing");
  List<Outcome> out=new ArrayList<>();
  for(int i=0;i<paths.size();i++){
   String path=paths.get(i);
   File source;try{source=resolve(path,false);}catch(IllegalArgumentException e){out.add(new Outcome(path,"invalid",null));continue;}
   if(!source.exists()){out.add(new Outcome(path,"missing",null));continue;}
   if(!copy&&source.getParentFile()!=null&&source.getParentFile().getCanonicalPath().equals(target.getCanonicalPath())){out.add(new Outcome(path,"unchanged",path));continue;}
   String sourcePath=source.getCanonicalPath(),targetPath=target.getCanonicalPath();
   if(source.isDirectory()&&(targetPath.equals(sourcePath)||targetPath.startsWith(sourcePath+File.separator))){out.add(new Outcome(path,"invalid",null));continue;}
   File destination=freeTarget(target,source.getName(),source.isDirectory());
   try{
    if(reviewed!=null&&!reviewed.get(i).equals(reviewedIdentity(source))){
     out.add(new Outcome(path,"changed",null));continue;
    }
    if(copy)copyFresh(source,destination);else moveFile(source,destination);
    out.add(new Outcome(path,copy?"copied":"moved",relative(destination)));
   }catch(IOException e){out.add(new Outcome(path,"failed",null));}
  }
  return out;
 }
 /** Rename refuses an existing name instead of replacing it, and a hidden (dot) name, which no
  * listing shows and which could name the trash. */
 public String rename(String path,String name)throws IOException{
  File source=resolve(path,false);validName(name);if(name.startsWith("."))throw new IllegalArgumentException("Invalid name");if(!source.exists())throw new java.io.FileNotFoundException();
  File destination=new File(source.getParentFile(),name);
  if(isLink(destination))throw new IllegalStateException("exists");
  if(destination.exists()&&!Files.isSameFile(source.toPath(),destination.toPath()))throw new IllegalStateException("exists");
  if(!source.renameTo(destination))throw new IOException("Rename failed");
  return relative(destination);
 }
 public String createFolder(String parent,String name)throws IOException{
  File folder=resolve(parent,true);validName(name);if(name.startsWith("."))throw new IllegalArgumentException("Invalid name");
  if(!folder.isDirectory())throw new java.io.FileNotFoundException();
  File created=freeTarget(folder,name,true);if(!created.mkdir())throw new IOException("Folder not created");return relative(created);
 }

 /** Reading Trash never creates it; only the first trash does. */
 File checkedTrash()throws IOException{
  File trash=new File(root,trashFolder);
  if(isLink(trash)||isLink(new File(trash,"files"))||isLink(new File(trash,"info")))throw new IOException("Trash unavailable");
  return trash;
 }
 File existingTrash()throws IOException{
  File trash=checkedTrash();
  return isDirectory(new File(trash,"info"))&&isDirectory(new File(trash,"files"))?trash:null;
 }
 File trashRoot()throws IOException{
  File trash=checkedTrash();
  File marker=new File(trash,".nomedia");
  if(isLink(marker))throw new IOException("Trash unavailable");
  Files.createDirectories(new File(trash,"files").toPath());
  Files.createDirectories(new File(trash,"info").toPath());
  if(!exists(marker))marker.createNewFile();
  return trash;
 }
 /** Move to trash with the origin folder recorded first, so a crash never loses the way back. */
 public List<Outcome> trash(List<String> paths,long now)throws IOException{
  return trash(paths,now,null);
 }
 public List<Outcome> trash(List<String> paths,long now,List<String> reviewed)throws IOException{
  checkReviewed(paths,reviewed);
  File trash=reviewed==null?trashRoot():null;
  List<Outcome> out=new ArrayList<>();
  for(int i=0;i<paths.size();i++){
   String path=paths.get(i);
   File source;try{source=resolve(path,false);}catch(IllegalArgumentException e){out.add(new Outcome(path,"invalid",null));continue;}
   if(!source.exists()){out.add(new Outcome(path,"missing",null));continue;}
   if(reviewed!=null&&!reviewed.get(i).equals(reviewedIdentity(source))){
    out.add(new Outcome(path,"changed",null));continue;
   }
   if(trash==null)trash=trashRoot();
   String id=UUID.randomUUID().toString();File info=new File(trash,"info/"+id+".json"),target=new File(trash,"files/"+id);
   boolean recorded=false;
   try{
    JSONObject record=new JSONObject();record.put("name",source.getName());record.put("origin",relative(source.getParentFile()));record.put("deletedAt",now);
    record.put("directory",source.isDirectory());record.put("size",source.isDirectory()?0:source.length());record.put("mime",source.isDirectory()?"":mime(source.getName()));
    write(info,record.toString());
    recorded=true;
    moveFile(source,target);
    out.add(new Outcome(path,"trashed",id));
   }catch(Exception e){if(recorded&&!exists(target))deleteRecord(root,info);out.add(new Outcome(path,"failed",null));}
  }
  return out;
 }
 public static final class TrashRow{public final String id,name,origin,mime;public final boolean directory;public final long size,deletedAt;
  TrashRow(String id,JSONObject r){this.id=id;name=r.optString("name");origin=r.optString("origin");mime=r.optString("mime");directory=r.optBoolean("directory");size=r.optLong("size");deletedAt=r.optLong("deletedAt");}}
 /** Items in trash, newest first. Items past the 30-day retention are deleted here. */
 public List<TrashRow> trashList(long now)throws IOException{
  File trash=existingTrash();List<TrashRow> out=new ArrayList<>();if(trash==null)return out;File[] infos=new File(trash,"info").listFiles();
  if(infos!=null)for(File info:infos){
   String id=info.getName().replaceAll("\\.json$","");if(!id.matches("[a-f0-9-]{36}"))continue;
   File data=new File(trash,"files/"+id);
   if(isLink(info)||isLink(data))continue;
   try{JSONObject r=new JSONObject(read(info));TrashRow row=new TrashRow(id,r);
    if(!exists(data)){deleteRecord(root,info);continue;}
    if(now>=row.deletedAt+RETENTION_MS&&deleteInside(root,data)){if(deleteRecord(root,info))continue;}
    out.add(row);
   }catch(Exception e){/* An unreadable record is left alone; its data stays recoverable by hand. */}
  }
  out.sort((a,b)->Long.compare(b.deletedAt,a.deletedAt));return out;
 }
 /** Back to the recorded origin (recreated when gone); a clash keeps both. */
 public List<Outcome> restore(List<String> ids)throws IOException{
  File trash=existingTrash();List<Outcome> out=new ArrayList<>();
  for(String id:ids){
   if(trash==null){out.add(new Outcome(id,"missing",null));continue;}
   if(id==null||!id.matches("[a-f0-9-]{36}")){out.add(new Outcome(id,"invalid",null));continue;}
   File info=new File(trash,"info/"+id+".json"),data=new File(trash,"files/"+id);
   if(isLink(info)||isLink(data)){out.add(new Outcome(id,"failed",null));continue;}
   if(!info.isFile()||!exists(data)){out.add(new Outcome(id,"missing",null));continue;}
   try{
    TrashRow row=new TrashRow(id,new JSONObject(read(info)));File origin;
    try{origin=resolve(row.origin,true);}catch(IllegalArgumentException e){origin=root;}
    if(!origin.isDirectory()&&!origin.mkdirs())throw new IOException();
    File destination=freeTarget(origin,validName(row.name),row.directory);
    moveFile(data,destination);deleteRecord(root,info);out.add(new Outcome(id,"restored",relative(destination)));
   }catch(Exception e){out.add(new Outcome(id,"failed",null));}
  }
  return out;
 }
 /** Permanent deletion of the items the owner confirmed (Empty or Delete now) in the UI. */
 public int emptyTrash(List<String> ids)throws IOException{
  if(ids==null)throw new IllegalArgumentException("Name the confirmed items");
  File trash=existingTrash();int count=0;if(trash==null)return 0;
  for(String id:ids){
   if(id==null||!id.matches("[a-f0-9-]{36}"))continue;
   File info=new File(trash,"info/"+id+".json"),data=new File(trash,"files/"+id);
   if(isLink(info)||isLink(data)||!deleteInside(root,data))continue;
   if(deleteRecord(root,info))count++;
  }
  return count;
 }

 void moveFile(File source,File destination)throws IOException{
  if(isLink(source)||exists(destination))throw new IOException("Unsafe move path");
  if(source.renameTo(destination))return;
  // Another volume or mount: copy, check, then remove the source. A failed copy leaves nothing
  // behind; once the copy is complete it is kept, since removing the source may have begun.
  copyFresh(source,destination);
  if(!deleteInside(root,source))throw new IOException("Source not removed");
 }
 /** A copy into a new destination that is removed again if the copy fails part way. */
 void copyFresh(File source,File destination)throws IOException{
  if(isDirectory(source)){
   Files.createDirectory(destination.toPath());
   try{
    File[] kids=source.listFiles();
    if(kids==null||!isDirectory(source))throw new IOException("Folder unreadable");
    for(File kid:kids)copyFresh(kid,new File(destination,kid.getName()));
   }catch(IOException e){
    deleteInside(root,destination);
    throw e;
   }
   return;
  }
  if(!Files.isRegularFile(source.toPath(),LinkOption.NOFOLLOW_LINKS))throw new IOException("Unsafe copy source");
  try(InputStream in=Files.newInputStream(source.toPath(),LinkOption.NOFOLLOW_LINKS)){
   OutputStream out=Files.newOutputStream(destination.toPath(),StandardOpenOption.CREATE_NEW);
   try(out){
    byte[] buffer=new byte[1<<16];
    int n;
    while((n=in.read(buffer))>0)out.write(buffer,0,n);
   }catch(IOException e){
    destination.delete();
    throw e;
   }
  }
  if(destination.length()!=source.length()){destination.delete();throw new IOException("Copy incomplete");}
  destination.setLastModified(source.lastModified());
 }
 private static boolean deleteRecord(File volume,File file){return deleteInside(volume,file,false);}
 static boolean deleteInside(File volume,File file){return deleteInside(volume,file,true);}
 private static boolean deleteInside(File volume,File file,boolean recursive){
  Path base=volume.toPath().toAbsolutePath().normalize();
  Path target=file.toPath().toAbsolutePath().normalize();
  if(target.equals(base)||!target.startsWith(base))return false;
  try(DirectoryStream<Path> stream=Files.newDirectoryStream(base)){
   if(stream instanceof SecureDirectoryStream<?>)
    return deleteAt((SecureDirectoryStream<Path>)stream,base.relativize(target),recursive);
   // Some host JVMs do not implement secure streams. Check every parent again
   // before traversing or deleting an entry on those providers.
   return deleteChecked(base,target,recursive);
  }catch(IOException e){return false;}
 }
 static boolean deleteRecursive(File file){return deleteInside(file.getAbsoluteFile().getParentFile(),file);}
 private static boolean deleteChecked(Path base,Path target,boolean recursive)throws IOException{
  for(Path parent=target.getParent();!parent.equals(base);parent=parent.getParent())
   if(Files.isSymbolicLink(parent))return false;
  if(Files.isDirectory(target,LinkOption.NOFOLLOW_LINKS)){
   if(!recursive)return false;
   try(DirectoryStream<Path> entries=Files.newDirectoryStream(target)){
    for(Path entry:entries)if(!deleteChecked(base,entry,true))return false;
   }
  }
  Files.deleteIfExists(target);
  return true;
 }
 private static boolean deleteAt(SecureDirectoryStream<Path> parent,Path target,boolean recursive)throws IOException{
  Path name=target.getName(0);
  if(target.getNameCount()>1){
   try(SecureDirectoryStream<Path> child=parent.newDirectoryStream(name,LinkOption.NOFOLLOW_LINKS)){
    return deleteAt(child,target.subpath(1,target.getNameCount()),recursive);
   }
  }
  BasicFileAttributes attributes;
  try{
   attributes=parent.getFileAttributeView(name,BasicFileAttributeView.class,LinkOption.NOFOLLOW_LINKS).readAttributes();
  }catch(NoSuchFileException missing){return true;}
  if(attributes.isDirectory()){
   if(!recursive)return false;
   try(SecureDirectoryStream<Path> child=parent.newDirectoryStream(name,LinkOption.NOFOLLOW_LINKS)){
    for(Path entry:child)if(!deleteAt(child,entry.getFileName(),true))return false;
   }
   parent.deleteDirectory(name);
  }else{
   // Unlink a nested link as an entry of the selected tree. Its target is never opened.
   parent.deleteFile(name);
  }
  return true;
 }
 static void write(File file,String text)throws IOException{
  ByteBuffer bytes=ByteBuffer.wrap(text.getBytes(StandardCharsets.UTF_8));
  try(FileChannel channel=FileChannel.open(file.toPath(),StandardOpenOption.WRITE,StandardOpenOption.CREATE_NEW)){
   try{
    while(bytes.hasRemaining())channel.write(bytes);
    channel.force(true);
   }catch(IOException e){
    file.delete();
    throw e;
   }
  }
 }
 static String read(File file)throws IOException{
  try(InputStream in=Files.newInputStream(file.toPath(),LinkOption.NOFOLLOW_LINKS)){
   java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();
   byte[] buffer=new byte[4096];
   int n;
   while((n=in.read(buffer))>0){
    if(out.size()+n>65536)throw new IOException("Record too large");
    out.write(buffer,0,n);
   }
   return new String(out.toByteArray(),StandardCharsets.UTF_8);
  }
 }
 /** Serializes registration with unwatch and rejects superseded queued requests. */
 public static final class WatchSlot {
  public interface Watch { void stop(); }
  private long generation;
  private Watch current;
  public synchronized long request(){return ++generation;}
  public synchronized boolean install(long ticket,java.util.function.Supplier<Watch> start){
   if(ticket!=generation)return false;
   stopCurrent();current=start.get();return true;
  }
  public synchronized boolean isCurrent(long ticket){return ticket==generation&&current!=null;}
  public synchronized void clear(){generation++;stopCurrent();}
  /** A refused latest request releases the previous folder's watch; a newer request is untouched. */
  public synchronized void fail(long ticket){if(ticket==generation)stopCurrent();}
  public synchronized boolean active(){return current!=null;}
  private void stopCurrent(){Watch old=current;current=null;if(old!=null)old.stop();}
 }
}
