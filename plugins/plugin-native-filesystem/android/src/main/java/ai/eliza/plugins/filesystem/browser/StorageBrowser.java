package ai.eliza.plugins.filesystem.browser;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
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
  for(String part:path.split("/"))validName(part);
  if(path.equals(trashFolder)||path.startsWith(trashFolder+"/"))throw new IllegalArgumentException("Invalid path");
  File file=new File(root,path);
  String base=root.getCanonicalPath(),target=file.getCanonicalPath();
  if(!target.equals(base)&&!target.startsWith(base+File.separator))throw new IllegalArgumentException("Invalid path");
  return file;
 }
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
   String name=f.getName();if(name.startsWith("."))continue;
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
    String name=kid.getName();if(name.startsWith(".")||!kid.isDirectory())continue;
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

 public static final class Outcome{public final String path,status,to;Outcome(String path,String status,String to){this.path=path;this.status=status;this.to=to;}}
 /** Move or copy each path into dest. A clash keeps both (spec MoveOne with FixConflict). */
 public List<Outcome> transfer(List<String> paths,String dest,boolean copy)throws IOException{
  File target=resolve(dest,true);if(!target.isDirectory())throw new java.io.FileNotFoundException("Destination missing");
  List<Outcome> out=new ArrayList<>();
  for(String path:paths){
   File source;try{source=resolve(path,false);}catch(IllegalArgumentException e){out.add(new Outcome(path,"invalid",null));continue;}
   if(!source.exists()){out.add(new Outcome(path,"missing",null));continue;}
   if(!copy&&source.getParentFile()!=null&&source.getParentFile().getCanonicalPath().equals(target.getCanonicalPath())){out.add(new Outcome(path,"unchanged",path));continue;}
   String sourcePath=source.getCanonicalPath(),targetPath=target.getCanonicalPath();
   if(source.isDirectory()&&(targetPath.equals(sourcePath)||targetPath.startsWith(sourcePath+File.separator))){out.add(new Outcome(path,"invalid",null));continue;}
   File destination=freeTarget(target,source.getName(),source.isDirectory());
   try{
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
  if(destination.exists()&&!destination.getCanonicalPath().equals(source.getCanonicalPath())&&!name.equalsIgnoreCase(source.getName()))throw new IllegalStateException("exists");
  if(!source.renameTo(destination))throw new IOException("Rename failed");
  return relative(destination);
 }
 public String createFolder(String parent,String name)throws IOException{
  File folder=resolve(parent,true);validName(name);if(name.startsWith("."))throw new IllegalArgumentException("Invalid name");
  if(!folder.isDirectory())throw new java.io.FileNotFoundException();
  File created=freeTarget(folder,name,true);if(!created.mkdir())throw new IOException("Folder not created");return relative(created);
 }

 /** Reading Trash never creates it; only the first trash does. */
 File existingTrash(){File trash=new File(root,trashFolder);return new File(trash,"info").isDirectory()&&new File(trash,"files").isDirectory()?trash:null;}
 File trashRoot()throws IOException{
  File trash=new File(root,trashFolder),files=new File(trash,"files"),info=new File(trash,"info");
  if(!files.isDirectory()&&!files.mkdirs()||!info.isDirectory()&&!info.mkdirs())throw new IOException("Trash unavailable");
  File marker=new File(trash,".nomedia");if(!marker.exists())marker.createNewFile();
  return trash;
 }
 /** Move to trash with the origin folder recorded first, so a crash never loses the way back. */
 public List<Outcome> trash(List<String> paths,long now)throws IOException{
  File trash=trashRoot();List<Outcome> out=new ArrayList<>();
  for(String path:paths){
   File source;try{source=resolve(path,false);}catch(IllegalArgumentException e){out.add(new Outcome(path,"invalid",null));continue;}
   if(!source.exists()){out.add(new Outcome(path,"missing",null));continue;}
   String id=UUID.randomUUID().toString();File info=new File(trash,"info/"+id+".json"),target=new File(trash,"files/"+id);
   try{
    JSONObject record=new JSONObject();record.put("name",source.getName());record.put("origin",relative(source.getParentFile()));record.put("deletedAt",now);
    record.put("directory",source.isDirectory());record.put("size",source.isDirectory()?0:source.length());record.put("mime",source.isDirectory()?"":mime(source.getName()));
    write(info,record.toString());
    moveFile(source,target);
    out.add(new Outcome(path,"trashed",id));
   }catch(Exception e){info.delete();out.add(new Outcome(path,"failed",null));}
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
   try{JSONObject r=new JSONObject(read(info));TrashRow row=new TrashRow(id,r);
    if(!data.exists()){info.delete();continue;}
    if(now>=row.deletedAt+RETENTION_MS){deleteRecursive(data);info.delete();continue;}
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
   if(!info.isFile()||!data.exists()){out.add(new Outcome(id,"missing",null));continue;}
   try{
    TrashRow row=new TrashRow(id,new JSONObject(read(info)));File origin;
    try{origin=resolve(row.origin,true);}catch(IllegalArgumentException e){origin=root;}
    if(!origin.isDirectory()&&!origin.mkdirs())throw new IOException();
    File destination=freeTarget(origin,validName(row.name),row.directory);
    moveFile(data,destination);info.delete();out.add(new Outcome(id,"restored",relative(destination)));
   }catch(Exception e){out.add(new Outcome(id,"failed",null));}
  }
  return out;
 }
 /** Permanent deletion of the items the owner confirmed (Empty or Delete now) in the UI. */
 public int emptyTrash(List<String> ids)throws IOException{
  if(ids==null)throw new IllegalArgumentException("Name the confirmed items");
  File trash=existingTrash();int count=0;if(trash==null)return 0;
  for(String id:ids){if(id==null||!id.matches("[a-f0-9-]{36}"))continue;File data=new File(trash,"files/"+id);if(data.exists()&&!deleteRecursive(data))continue;new File(trash,"info/"+id+".json").delete();count++;}
  return count;
 }

 static void moveFile(File source,File destination)throws IOException{
  if(destination.exists())throw new IOException("Destination exists");
  if(source.renameTo(destination))return;
  // Another volume or mount: copy, check, then remove the source. A failed copy leaves nothing
  // behind; once the copy is complete it is kept, since removing the source may have begun.
  copyFresh(source,destination);
  if(!deleteRecursive(source))throw new IOException("Source not removed");
 }
 /** A copy into a new destination that is removed again if the copy fails part way. */
 static void copyFresh(File source,File destination)throws IOException{
  if(destination.exists())throw new IOException("Destination exists");
  try{copyRecursive(source,destination);}catch(IOException e){deleteRecursive(destination);throw e;}
 }
 static void copyRecursive(File source,File destination)throws IOException{
  if(destination.exists())throw new IOException("Destination exists");
  if(source.isDirectory()){
   if(!destination.mkdir())throw new IOException("Folder not created");
   File[] kids=source.listFiles();if(kids==null)throw new IOException("Folder unreadable");
   for(File kid:kids)copyRecursive(kid,new File(destination,kid.getName()));
   return;
  }
  try(InputStream in=new FileInputStream(source);OutputStream out=new FileOutputStream(destination)){byte[] buffer=new byte[1<<16];int n;while((n=in.read(buffer))>0)out.write(buffer,0,n);}
  catch(IOException e){destination.delete();throw e;}
  if(destination.length()!=source.length()){destination.delete();throw new IOException("Copy incomplete");}
  destination.setLastModified(source.lastModified());
 }
 static boolean deleteRecursive(File file){File[] kids=file.isDirectory()?file.listFiles():null;if(kids!=null)for(File kid:kids)if(!deleteRecursive(kid))return false;return file.delete()||!file.exists();}
 static void write(File file,String text)throws IOException{try(OutputStream out=new FileOutputStream(file)){out.write(text.getBytes(StandardCharsets.UTF_8));out.flush();((FileOutputStream)out).getFD().sync();}}
 static String read(File file)throws IOException{if(file.length()>65536)throw new IOException("Record too large");try(InputStream in=new FileInputStream(file)){java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[4096];int n;while((n=in.read(buffer))>0)out.write(buffer,0,n);return new String(out.toByteArray(),StandardCharsets.UTF_8);}}
}
