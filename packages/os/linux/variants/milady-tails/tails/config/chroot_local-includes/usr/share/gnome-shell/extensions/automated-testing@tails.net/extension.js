import Gio from 'gi://Gio';

export default class AutomatedTestingExtension {
  enable() {
    let file = Gio.File.new_for_path("/proc/cmdline");
    let [_, contents] = file.load_contents(null);
    let decoder = new TextDecoder;
    if (!decoder.decode(contents).split(" ").includes("autotest_never_use_this_option")) return;
    // Enable the D-Bus Introspect API, required by Ponytail.
    global.context.unsafe_mode = true;
    // Ponytail will fail to initialize if it cannot open a new
    // session, which it cannot while remote access is inhibited. GDM
    // sessions start with remote access inhibited.
    global.backend.get_remote_access_controller().uninhibit_remote_access();
    if (this.orig !== undefined) return;
    this.orig = global.backend.get_remote_access_controller().inhibit_remote_access;
    // For completeness, let's make it impossible to inhibit remote
    // access by overriding the corresponding method.
    global.backend.get_remote_access_controller().inhibit_remote_access = () => {};
  }

  disable() {
    global.context.unsafe_mode = false;
    if (this.orig === undefined) return;
    global.backend.get_remote_access_controller().inhibit_remote_access = this.orig;
    delete this.orig;
  }
}
