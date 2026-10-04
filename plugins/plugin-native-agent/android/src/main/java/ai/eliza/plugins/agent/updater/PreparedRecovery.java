package ai.eliza.plugins.agent.updater;

import java.io.IOException;
import java.util.Objects;

/** Reopens cached recovery material without discovery or installation. Hosts must
 * authenticate material and supply current installed identity and security floor.
 * The installer must still revalidate trust, APK bytes and identity at commit. */
public final class PreparedRecovery {
  private PreparedRecovery() {}
  public interface Installed { UpdateJournal.Identity read() throws Exception; }
  public interface Authority { Material load(UpdateJournal.Plan plan, long securityFloor) throws Exception; }
  public static final class Material {
    public final String distribution, approvedHosts;
    private final byte[] artifact;
    public Material(String distribution, byte[] artifact, String approvedHosts) {
      this.distribution = Objects.requireNonNull(distribution);
      this.artifact = Objects.requireNonNull(artifact).clone();
      this.approvedHosts = Objects.requireNonNull(approvedHosts);
    }
    public byte[] artifact() { return artifact.clone(); }
  }
  public static final class Authorization {
    public final String planId;
    public final long securityFloor;
    public final Material material;
    private Authorization(String planId, long securityFloor, Material material) {
      this.planId = planId; this.securityFloor = securityFloor; this.material = material;
    }
  }
  public static Authorization open(UpdateJournal journal, Installed installed,
      Authority authority, long securityFloor) throws Exception {
    Objects.requireNonNull(journal); Objects.requireNonNull(installed); Objects.requireNonNull(authority);
    UpdateJournal.Snapshot before = journal.read();
    requireReady(before, installed.read());
    Material material = authority.load(before.plan, securityFloor);
    if (material == null || !before.plan.distribution.equals(material.distribution))
      throw new IOException("Recovery distribution changed or material unavailable");
    // Trust reads may block. Do not publish a result selected from stale state.
    UpdateJournal.Snapshot after = journal.read();
    requireReady(after, installed.read());
    if (after.revision != before.revision)
      throw new IOException("Recovery state changed while loading authorization");
    return new Authorization(before.plan.id, securityFloor, material);
  }
  private static void requireReady(UpdateJournal.Snapshot state, UpdateJournal.Identity installed) throws IOException {
    if (state.phase != UpdateJournal.Phase.RECOVERY_READY || state.plan == null
        || installed == null || !state.plan.candidate.matches(installed))
      throw new IOException("No matching candidate awaiting recovery");
  }
}
