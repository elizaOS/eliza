// spec/os/agentService/channel.md, "The token is written only to a socket whose peer is this app"
package ai.eliza.os.agent;

public final class PeerCheck {
  private PeerCheck() {}

  public static void main(String[] args) {
    Integer[] peers = { 1, 2, null };
    for (Integer peer : peers)
      for (int appUid = 1; appUid <= 2; appUid++)
        System.out.println("{\"peer\":" + peer + ",\"appUid\":" + appUid + ",\"trusted\":" + ChannelPolicy.peerTrusted(peer, appUid) + "}");
  }
}
