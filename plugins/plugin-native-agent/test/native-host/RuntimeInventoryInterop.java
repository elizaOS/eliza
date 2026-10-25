package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.RuntimeBundleStore;
import java.nio.file.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPInputStream;

/** Consume the actual Node-produced inventory using the deployed Java extractor. */
public final class RuntimeInventoryInterop {
 public static void main(String[] args) throws Exception {
  Path root=Path.of(args[0]),assets=root.resolve("assets"),nativeDir=root.resolve("native");
  RuntimeBundleStore.Durability durability=directory->{try(FileChannel channel=FileChannel.open(directory,StandardOpenOption.READ)){channel.force(true);}};
  byte[] inventory=Files.readAllBytes(assets.resolve("agent-runtime.inventory"));
  Path bundle=RuntimeBundleStore.prepare(root.resolve("versions"),inventory,asset->Files.newInputStream(assets.resolve(asset)),nativeDir,durability,"eliza-runtime-v1");
  if(!Files.readString(bundle.resolve("agent-bundle.js")).equals("synthetic agent fixture"))throw new AssertionError("Wrong agent bytes");
  try(GZIPInputStream stream=new GZIPInputStream(Files.newInputStream(bundle.getParent().resolve("extension.tar.gz")))) {
   if(!new String(stream.readAllBytes(),StandardCharsets.UTF_8).equals("synthetic tar fixture"))throw new AssertionError("Wrong archive bytes");
  }
  Path restored=RuntimeBundleStore.prepare(root.resolve("versions"),inventory,asset->{throw new AssertionError("Restored inventory must reuse its verified release");},nativeDir,durability,"eliza-runtime-v1");
  if(!restored.equals(bundle))throw new AssertionError("Unstable runtime identity");
  Files.writeString(bundle.resolve("agent-bundle.js"),"tampered");
  try {RuntimeBundleStore.prepare(root.resolve("versions"),inventory,asset->Files.newInputStream(assets.resolve(asset)),nativeDir,durability,"eliza-runtime-v1");throw new AssertionError("Tampered release accepted");}
  catch(java.io.IOException expected) {}
  System.out.println("Node inventory / Java extraction, restart reuse, gzip and tamper rejection passed");
 }
}
