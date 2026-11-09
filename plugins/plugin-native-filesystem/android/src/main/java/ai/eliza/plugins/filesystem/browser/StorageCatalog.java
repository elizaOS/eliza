package ai.eliza.plugins.filesystem.browser;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.MediaStore;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** Storage volumes and the Browse categories (primary volume): Downloads is the Download folder;
 * Images/Videos/Audio/Documents are queries over MediaStore. Category listings are never the
 * system picker's Recent view. */
public final class StorageCatalog {
 public static final int CATEGORY_MAX=2000,QUERY_MAX=500;
 /** Every Browse category id, as the shared Files storage model names them. */
 public static final String[] CATEGORY_IDS={"downloads","images","videos","audio","documents"};
 public static final String DOWNLOAD_FOLDER="Download";
 static final String[] DOCUMENT_TYPES={"application/pdf","application/msword","application/rtf","text/plain","text/csv","text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint","application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text","application/vnd.oasis.opendocument.spreadsheet","application/vnd.oasis.opendocument.presentation"};
 private StorageCatalog(){}

 /** All-files access as Android reports it; API 29 has no such access. */
 public static String access(){
  if(Build.VERSION.SDK_INT<Build.VERSION_CODES.R)return "unsupported";
  return Environment.isExternalStorageManager()?"granted":"denied";
 }

 /** Storage access as Android reports it: all-files access on API 30+; on API 29 (legacy storage,
  * requestLegacyExternalStorage) both READ_ and WRITE_EXTERNAL_STORAGE. */
 public static String access(Context context){
  if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.R)return access();
  if(Build.VERSION.SDK_INT<Build.VERSION_CODES.Q)return "unsupported";
  for(String permission:LEGACY_PERMISSIONS)if(context.checkSelfPermission(permission)!=android.content.pm.PackageManager.PERMISSION_GRANTED)return "denied";
  return "granted";
 }
 /** The runtime permissions Files needs on API 29, where all-files access does not exist. */
 private static final String[] LEGACY_PERMISSIONS={android.Manifest.permission.READ_EXTERNAL_STORAGE,android.Manifest.permission.WRITE_EXTERNAL_STORAGE};
 /** Whether Files asks for {@link #LEGACY_PERMISSIONS} instead of opening the all-files access page. */
 public static boolean legacy(){return Build.VERSION.SDK_INT==Build.VERSION_CODES.Q;}

 public static final class Volume{public final String id,name;public final boolean primary;public final File directory;Volume(String id,String name,boolean primary,File directory){this.id=id;this.name=name;this.primary=primary;this.directory=directory;}}
 public static List<Volume> volumes(Context context){
  List<Volume> out=new ArrayList<>();
  if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.R){
   StorageManager manager=context.getSystemService(StorageManager.class);
   for(StorageVolume volume:manager.getStorageVolumes()){
    File dir=volume.getDirectory();if(dir==null||!Environment.MEDIA_MOUNTED.equals(volume.getState()))continue;
    boolean primary=volume.isPrimary();String uuid=volume.getUuid();
    if(!primary&&(uuid==null||!uuid.matches("[A-Za-z0-9-]{1,64}")))continue;
    out.add(new Volume(primary?"primary":uuid,primary?"Internal storage":volume.getDescription(context),primary,dir));
   }
  }
  if(out.isEmpty())out.add(new Volume("primary","Internal storage",true,Environment.getExternalStorageDirectory()));
  return out;
 }
 public static Volume volume(Context context,String id){for(Volume v:volumes(context))if(v.id.equals(id==null?"primary":id))return v;return null;}
 public static JSObject describe(Volume volume){
  JSObject row=new JSObject();row.put("id",volume.id);row.put("name",volume.name);row.put("primary",volume.primary);
  try{StatFs stat=new StatFs(volume.directory.getPath());row.put("free",stat.getAvailableBytes());row.put("total",stat.getTotalBytes());}catch(IllegalArgumentException e){row.put("free",0);row.put("total",0);}
  return row;
 }

 private static Uri collection(String category){
  String volume=MediaStore.VOLUME_EXTERNAL_PRIMARY;
  switch(category){
   case "images":return MediaStore.Images.Media.getContentUri(volume);
   case "videos":return MediaStore.Video.Media.getContentUri(volume);
   case "audio":return MediaStore.Audio.Media.getContentUri(volume);
   default:return MediaStore.Files.getContentUri(volume);
  }
 }
 private static final String[] COLUMNS={MediaStore.MediaColumns.RELATIVE_PATH,MediaStore.MediaColumns.DISPLAY_NAME,MediaStore.MediaColumns.MIME_TYPE,MediaStore.MediaColumns.SIZE,MediaStore.MediaColumns.DATE_MODIFIED};
 /** One Browse category on the primary volume (`browser`): the files directly in Download/, or a
  * MediaStore query. A missing Download folder is an empty category. `entries` holds at most
  * CATEGORY_MAX rows, newest first; `count` is every file in the category and `truncated` says
  * rows were left out; `folders` groups every file by its folder (count and newest row). */
 public static JSObject category(ContentResolver resolver,StorageBrowser browser,String category)throws java.io.IOException{
  if(!"downloads".equals(category))return category(resolver,category);
  JSArray entries=new JSArray();List<StorageBrowser.Row> files=browser.files(DOWNLOAD_FOLDER,Integer.MAX_VALUE);
  for(StorageBrowser.Row r:files){if(entries.length()>=CATEGORY_MAX)break;
   JSObject row=new JSObject();row.put("path",r.path);row.put("name",r.name);row.put("directory",false);row.put("mimeType",r.mime);row.put("size",r.size);row.put("modified",r.modified);entries.put(row);}
  JSObject out=new JSObject();out.put("entries",entries);out.put("count",files.size());out.put("truncated",files.size()>entries.length());
  return out;
 }
 /** A category's MediaStore selection, or null for every row of its collection. */
 private static String selection(String category){
  if("documents".equals(category)){StringBuilder in=new StringBuilder();for(int i=0;i<DOCUMENT_TYPES.length;i++)in.append(i==0?"?":",?");return MediaStore.MediaColumns.MIME_TYPE+" IN ("+in+")";}
  if(!"images".equals(category)&&!"videos".equals(category)&&!"audio".equals(category))throw new IllegalArgumentException("Unknown category");
  return null;
 }
 /** Matches the hidden-name and hidden-folder filtering in rows(). */
 public static final String VISIBLE="relative_path IS NOT NULL AND _display_name IS NOT NULL AND _display_name NOT LIKE '.%' AND ('/'||relative_path) NOT LIKE '%/.%'";
 /** Browse needs counts without loading and serializing every media row. */
 public static JSObject count(ContentResolver resolver,StorageBrowser browser,String category)throws java.io.IOException{
  JSObject out=new JSObject();
  if("downloads".equals(category)){out.put("count",browser.files(DOWNLOAD_FOLDER,Integer.MAX_VALUE).size());return out;}
  String selection=selection(category);
  try(Cursor cursor=resolver.query(collection(category),new String[]{MediaStore.MediaColumns._ID},selection==null?VISIBLE:selection+" AND "+VISIBLE,selection==null?null:DOCUMENT_TYPES,null)){
   if(cursor==null)throw new IllegalStateException("Media provider unavailable");
   out.put("count",cursor.getCount());
  }
  return out;
 }
 /** One MediaStore category over the primary volume, newest first. Trash and pending rows are excluded by MediaStore. */
 public static JSObject category(ContentResolver resolver,String category){
  String selection=selection(category);String[] args=selection==null?null:DOCUMENT_TYPES;
  Tally tally=new Tally();JSArray entries=rows(resolver,collection(category),selection,args,CATEGORY_MAX,tally);
  JSObject out=new JSObject();out.put("entries",entries);out.put("count",tally.count);out.put("truncated",tally.count>entries.length());
  JSArray folders=new JSArray();
  for(java.util.Map.Entry<String,Object[]> e:tally.folders.entrySet()){JSObject f=new JSObject();f.put("folder",e.getKey());f.put("count",(int)e.getValue()[0]);f.put("latest",e.getValue()[1]);folders.put(f);}
  out.put("folders",folders);
  return out;
 }
 /** Every visible row of a category, counted, and grouped by folder (newest row first seen). */
 static final class Tally{int count;final java.util.LinkedHashMap<String,Object[]> folders=new java.util.LinkedHashMap<>();}
 /** Candidates for the agent's read-only filter; the renderer applies the exact filter rules. */
 public static JSArray query(ContentResolver resolver,String text,String mimePrefix,boolean documents,String folder,long from,long to){
  List<String> clauses=new ArrayList<>(),args=new ArrayList<>();
  // Documents are a set of types, so the newest rows of other types never crowd them out.
  if(documents){StringBuilder in=new StringBuilder();for(int i=0;i<DOCUMENT_TYPES.length;i++){in.append(i==0?"?":",?");args.add(DOCUMENT_TYPES[i]);}clauses.add(MediaStore.MediaColumns.MIME_TYPE+" IN ("+in+")");}
  if(text!=null)for(String word:text.toLowerCase(java.util.Locale.ROOT).split("[^\\p{L}\\p{N}]+"))if(!word.isEmpty()){clauses.add("LOWER("+MediaStore.MediaColumns.DISPLAY_NAME+") LIKE ? ESCAPE '\\'");args.add("%"+word.replace("\\","\\\\").replace("%","\\%").replace("_","\\_")+"%");}
  if(mimePrefix!=null&&!mimePrefix.isEmpty()){clauses.add(MediaStore.MediaColumns.MIME_TYPE+" LIKE ?");args.add(mimePrefix.replace("%","")+"%");}
  if(folder!=null&&!folder.isEmpty()){clauses.add(MediaStore.MediaColumns.RELATIVE_PATH+" LIKE ? ESCAPE '\\'");args.add(folder.replace("\\","\\\\").replace("%","\\%").replace("_","\\_")+"/%");}
  if(from>0){clauses.add(MediaStore.MediaColumns.DATE_MODIFIED+" >= ?");args.add(String.valueOf(from/1000));}
  if(to>0){clauses.add(MediaStore.MediaColumns.DATE_MODIFIED+" <= ?");args.add(String.valueOf(to/1000));}
  clauses.add(MediaStore.MediaColumns.MIME_TYPE+" IS NOT NULL");
  return rows(resolver,MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),String.join(" AND ",clauses),args.toArray(new String[0]),QUERY_MAX,null);
 }
 /** Rows newest first, at most `limit`; with a tally every row is read so counts are not capped. */
 private static JSArray rows(ContentResolver resolver,Uri uri,String selection,String[] args,int limit,Tally tally){
  JSArray out=new JSArray();
  try(Cursor cursor=resolver.query(uri,COLUMNS,selection,args,MediaStore.MediaColumns.DATE_MODIFIED+" DESC")){
   if(cursor==null)return out;
   while(cursor.moveToNext()&&(tally!=null||out.length()<limit)){
    String relative=cursor.getString(0),name=cursor.getString(1);if(relative==null||name==null)continue;
    String folder=relative.replaceAll("/+$","");
    // Hidden folders (the trash included) are not shown in categories.
    if(name.startsWith(".")||("/"+folder).contains("/."))continue;
    Object[] group=null;
    if(tally!=null){tally.count++;group=tally.folders.get(folder);if(group!=null)group[0]=(int)group[0]+1;}
    boolean listed=out.length()<limit,first=tally!=null&&group==null;
    if(!listed&&!first)continue;
    JSObject row=new JSObject();row.put("path",folder.isEmpty()?name:folder+"/"+name);row.put("name",name);row.put("directory",false);
    row.put("mimeType",cursor.isNull(2)?"application/octet-stream":cursor.getString(2));row.put("size",cursor.isNull(3)?0:cursor.getLong(3));row.put("modified",cursor.isNull(4)?0:cursor.getLong(4)*1000);
    if(listed)out.put(row);
    if(first)tally.folders.put(folder,new Object[]{1,row});
   }
  }
  return out;
 }
}
