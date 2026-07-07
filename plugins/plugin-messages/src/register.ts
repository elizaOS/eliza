/**
 * `appRegister` side-effect entry for the Messages plugin. Currently a no-op:
 * the Messages view ships GUI-only via the plugin manifest, but the entry stays
 * because the renderer build's manifest scan (`elizaos.appRegister` in
 * package.json) requires the declared module to exist.
 */
export {};
