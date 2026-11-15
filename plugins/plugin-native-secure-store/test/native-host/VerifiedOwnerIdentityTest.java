package ai.eliza.plugins.securestore.nativeonly;

/** Prints the native owner identity of each authority, userId, organizationId triple in args. */
public final class VerifiedOwnerIdentityTest {
  public static void main(String[] args) throws Exception {
    if (args.length % 3 != 0) throw new IllegalArgumentException("Owner triples required");
    for (int i = 0; i < args.length; i += 3)
      System.out.println(VerifiedOwnerIdentity.of(args[i], args[i + 1], args[i + 2]));
  }
}
