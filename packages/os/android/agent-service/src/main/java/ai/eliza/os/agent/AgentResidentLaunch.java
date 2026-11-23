// spec/os/agentService/residentBinding.md, "The resident launch needs its own readable vault, even without inference"; spec/os/agentService/residentBinding.md, "Cloud inference uses the exact linked account and a newer key can rotate in place"
package ai.eliza.os.agent;

import java.util.Objects;

record AgentResidentLaunch(AgentCredentials.ResidentState binding, AgentConfig.ResidentInference inference,
    AgentCredentials.Active cloud, LaunchFrame.Credential framed) {

  static AgentResidentLaunch select(AgentConfig config, AgentCredentials.ResidentState binding, long now) {
    AgentCredentials.VerifiedCloud verified = binding.cloud();
    if (config.cloudOrigin() != null && verified != null && verified.origin().equals(binding.linkedOrigin())
        && verified.origin().equals(AgentCredentials.canonicalOrigin(config.cloudOrigin()))) {
      AgentCredentials.Active key = verified.credential();
      if (key.account().equals(binding.owner().linkedAccount()) && (key.expiresAt() == 0 || key.expiresAt() > now))
        return new AgentResidentLaunch(binding, new AgentConfig.CloudInference(key.account()), key, LaunchFrame.Credential.of(key));
    }
    if (config.ownKey() && binding.ownKey() != null)
      return new AgentResidentLaunch(binding, new AgentConfig.OwnKeyInference(), null, binding.ownKey());
    return new AgentResidentLaunch(binding, new AgentConfig.NoInference(), null, null);
  }

  long cloudVersion() { return cloud == null ? 0 : cloud.version(); }

  AgentPolicy.ResidentRollout rolloutTo(AgentResidentLaunch next) {
    if (!sameVault(next) || !inference.equals(next.inference)) return AgentPolicy.ResidentRollout.RETIRE_LAUNCH;
    if (cloud != null) return next.cloudVersion() > cloudVersion()
      ? AgentPolicy.ResidentRollout.ROTATE_KEY : AgentPolicy.ResidentRollout.KEEP_LAUNCH;
    return Objects.equals(framed, next.framed) ? AgentPolicy.ResidentRollout.KEEP_LAUNCH : AgentPolicy.ResidentRollout.RETIRE_LAUNCH;
  }

  private boolean sameVault(AgentResidentLaunch next) {
    AgentConfig.ResidentOwner owner = binding.owner();
    AgentConfig.ResidentOwner other = next.binding.owner();
    return owner.getClass() == other.getClass() && binding.storageKey().equals(next.binding.storageKey())
      && (!(owner instanceof AgentConfig.RetainedOwner) || owner.linkedAccount().equals(other.linkedAccount()));
  }

  @Override public String toString() { return "AgentResidentLaunch(" + inference.getClass().getSimpleName() + ")"; }
}
