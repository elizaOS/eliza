// spec/os/signIn/cloudRequests.md, "Story: Reach my account's cloud services without holding my key"
package ai.eliza.plugins.signin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

public final class LargeBodyGrant {
  public static final int CHUNK = 2 << 20;

  public record Grant(String id, long size, String sha256, String contentType) {}
  public record Chunk(byte[] data, boolean done) {}
  public static final class Oversize extends IOException {
    public Oversize() { super("the body is larger than " + CloudRequestPolicy.BODY_LIMIT + " bytes"); }
  }

  private record Held(Grant grant, File file, long read) {}

  private final File directory;
  private final SecureRandom random = new SecureRandom();
  private final Map<String, Held> held = new HashMap<>();

  public LargeBodyGrant(File cacheDirectory) {
    directory = new File(cacheDirectory, "cloud-bodies");
    File[] stale = directory.listFiles();
    if (stale != null) for (File file : stale) file.delete();
    directory.mkdirs();
  }

  public Grant spill(byte[] head, InputStream rest, String contentType) throws IOException {
    MessageDigest digest = sha256();
    File partial = File.createTempFile("body-", ".part", directory);
    long size = 0;
    try (OutputStream out = new FileOutputStream(partial)) {
      out.write(head);
      digest.update(head);
      size = head.length;
      byte[] buffer = new byte[64 << 10];
      for (int n; (n = rest.read(buffer)) > 0;) {
        size += n;
        if (size > CloudRequestPolicy.BODY_LIMIT) throw new Oversize();
        out.write(buffer, 0, n);
        digest.update(buffer, 0, n);
      }
    } catch (IOException failed) {
      partial.delete();
      throw failed;
    }
    String sha = hex(digest.digest());
    File named = new File(directory, sha);
    synchronized (this) {
      if (named.exists()) partial.delete();
      else if (!partial.renameTo(named)) { partial.delete(); throw new IOException("the body could not be kept under its digest"); }
      byte[] token = new byte[32];
      random.nextBytes(token);
      Grant grant = new Grant(Base64.getUrlEncoder().withoutPadding().encodeToString(token), size, sha, contentType);
      held.put(grant.id(), new Held(grant, named, 0));
      return grant;
    }
  }

  public synchronized Chunk read(String id) throws IOException {
    Held grant = id == null ? null : held.get(id);
    if (grant == null) return null;
    long left = grant.grant().size() - grant.read();
    byte[] data = new byte[(int) Math.min(CHUNK, left)];
    try (RandomAccessFile file = new RandomAccessFile(grant.file(), "r")) {
      file.seek(grant.read());
      file.readFully(data);
    } catch (IOException lost) {
      release(id);
      throw lost;
    }
    boolean done = grant.read() + data.length >= grant.grant().size();
    if (done) release(id);
    else held.put(id, new Held(grant.grant(), grant.file(), grant.read() + data.length));
    return new Chunk(data, done);
  }

  public synchronized void clear() {
    for (String id : Map.copyOf(held).keySet()) release(id);
  }

  private void release(String id) {
    Held gone = held.remove(id);
    if (gone != null && held.values().stream().noneMatch(other -> other.file().equals(gone.file()))) gone.file().delete();
  }

  private static String hex(byte[] bytes) {
    StringBuilder text = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) text.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
    return text.toString();
  }

  private static MessageDigest sha256() {
    try { return MessageDigest.getInstance("SHA-256"); }
    catch (NoSuchAlgorithmException absent) { throw new IllegalStateException(absent); }
  }
}
