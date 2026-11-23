package android.security.keystore;

public final class KeyGenParameterSpec implements java.security.spec.AlgorithmParameterSpec {
  private final String alias;

  private KeyGenParameterSpec(String alias) {
    this.alias = alias;
  }

  public String getKeystoreAlias() {
    return alias;
  }

  public static final class Builder {
    private final String alias;

    public Builder(String alias, int purposes) {
      this.alias = alias;
    }

    public Builder setBlockModes(String... modes) { return this; }
    public Builder setEncryptionPaddings(String... paddings) { return this; }
    public Builder setKeySize(int bits) { return this; }
    public KeyGenParameterSpec build() { return new KeyGenParameterSpec(alias); }
  }
}
