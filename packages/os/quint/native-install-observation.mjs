/** Optional source observations from the existing staging regression fixtures. */
export function observeNativeInstall(test, observation) {
  if (process.env.ELIZA_NATIVE_INSTALL_MODEL === "1") {
    const row = { ...observation };
    if (row.source)
      row.source = row.source.map(({ name, sha256 }) => ({ name, sha256 }));
    test.diagnostic(
      `NATIVE_INSTALL_MODEL ${Buffer.from(JSON.stringify(row)).toString("base64")}`,
    );
  }
}
