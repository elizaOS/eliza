import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';

var settings;

export default class DateExtension {

    init() {
    }

    overrider() {
        var now = new Date();
        let [res, out] = GLib.spawn_sync(null, ['sudo', '-n', '/usr/local/lib/tails-get-date'], null, GLib.SpawnFlags.SEARCH_PATH, null);
        if(out == null) {
            var desired = now.toLocaleString('en-US') + ' GMT';
        } else {
            const decoder = new TextDecoder()
            desired = decoder.decode(out).trim();
        }

        var t = this.lbl.get_text();
        if (t != desired) {
            this.last = t;
            this.lbl.set_text(desired);
        }
    }


    enable() {
        this.lbl = null;
        this.signalHandlerID = null;
        this.last = "";
        var sA = Main.panel.statusArea;
        if (!sA) { sA = Main.panel._statusArea; }

        if (!sA || !sA.dateMenu) {
            print("Looks like Shell has changed where things live again; aborting.");
            return;
        }

        sA.dateMenu.first_child.get_children().forEach((w) => {
            // assume that the text label is the first StLabel we find.
            // This is dodgy behaviour but there's no reliable way to
            // work out which it is.
            w.set_style("text-align: center;");
            if (w.get_text && !this.lbl) {
                this.lbl = w;
            }
        });
        if (!this.lbl) {
            print("Looks like Shell has changed where things live again; aborting.");
            return;
        }
        this.signalHandlerID = this.lbl.connect("notify::text", () => { this.overrider() });
        this.last = this.lbl.get_text();
        this.overrider();
    }

    disable() {
        if (this.lbl && this.signalHandlerID) {
            this.lbl.disconnect(this.signalHandlerID);
            this.lbl.set_text(this.last);
        }
    }
}
