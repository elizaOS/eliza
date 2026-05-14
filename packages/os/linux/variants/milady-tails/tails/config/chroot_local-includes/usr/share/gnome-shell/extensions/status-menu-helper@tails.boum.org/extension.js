/**
   Copyright (C) 2014 Raphael Freudiger <laser_b@gmx.ch>
   Copyright (C) 2014 Jonatan Zeidler <jonatan_zeidler@gmx.de>
   Copyright (C) 2014-2017 Tails Developers <foundations@tails.net>

   This program is free software: you can redistribute it and/or
   modify it under the terms of the GNU General Public License as
   published by the Free Software Foundation, either version 2 of the
   License, or (at your option) any later version.

   This program is distributed in the hope that it will be useful, but
   WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with this program.  If not, see <http://www.gnu.org/licenses/>.

   status-menu-helper is based on gnome-shell-extension-suspend-button
   (https://github.com/laserb/gnome-shell-extension-suspend-button) by
   Raphael Freudiger <laser_b@gmx.ch>.
**/
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import GLib from 'gi://GLib';
import * as Gettext from 'gettext';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

Gettext.textdomain('tails');
const _ = Gettext.gettext;

function initTranslations(extension) {
    let localeDir = extension.dir.get_child('locale').get_path();

    // Extension installed in .local
    if (GLib.file_test(localeDir, GLib.FileTest.EXISTS)) {
        Gettext.bindtextdomain('gnome-shell-extension-status-menu-helper', localeDir);
    }
    // Extension installed system-wide
    else {
        Gettext.bindtextdomain('gnome-shell-extension-status-menu-helper',
            Config.LOCALEDIR);
    }
}

export default class StatusMenuHelperExtension {

    enable() {
        if (this._isEnabled) return;
        this._isEnabled = true;
        this.setupTimer = setInterval(() => { this.setup() }, 2000); // try until it works
    }

    setup() {
        console.log("setup()...")
        this.statusMenu = Main.panel.statusArea.quickSettings;

        if(
            this.statusMenu === undefined ||
            this.statusMenu._system === undefined ||
            this.statusMenu._system._systemItem === undefined ||
            this.statusMenu._system._systemItem.child === undefined
        ) {
            return;
        }
        const statusMenuTopButtons = this.statusMenu._system._systemItem.child.get_children();
        for (var item of statusMenuTopButtons) {
            if (item.constructor.name == "LockItem") {
                this._origLockItem = item;
            } else if (item.constructor.name == "ShutdownItem") {
                this._origShutdownItem = item;
            }
        }

        this._createActions();
        this._hideOrigActions();
        this._addSeparateButtons();

        this._menuOpenStateChangedId = this.statusMenu.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                return;
            this._onMenuOpen();
        });

        console.log("setup() COMPLETE")
        clearInterval(this.setupTimer)
    }

    disable() {
        // We want to keep the extension enabled on the lock screen
        if (Main.sessionMode.isLocked) return;
        if (!this._isEnabled) return;
        this._isEnabled = false;

        this._destroyActions();
        this._restoreOrigActions();

        this.statusMenu.menu.disconnect(this._menuOpenStateChangedId);
    }

    _createActions() {
        this._lockScreenAction = this._createAction(_("Lock Screen"),
                                                   'changes-prevent-symbolic',
                                                    this._onLockClicked);

        this._suspendAction = this._createAction(_("Suspend"),
                                                 'media-playback-pause-symbolic',
                                                 this._onSuspendClicked);

        this._restartAction = this._createAction(_("Restart"),
                                                 'view-refresh-symbolic',
                                                 this._onRestartClicked);

        this._powerOffAction = this._createAction(_("Power Off"),
                                                  'system-shutdown-symbolic',
                                                  this._onPowerOffClicked);

        this._actions = [this._lockScreenAction, this._suspendAction,
                         this._restartAction, this._powerOffAction];
    }

    _createAction(label, icon, onClickedFunction) {
        const item = new PopupMenu.PopupImageMenuItem(label, icon);
        item.connect('activate', onClickedFunction);
        return item;
    }

    _hideOrigActions() {
        this._origLockItem.hide();
        this._origShutdownItem.hide();
    }

    _restoreOrigActions() {
        this._origLockItem.show();
        this._origShutdownItem.show();
    }

    _addSeparateButtons() {
        for(const action of this._actions) {
            this.statusMenu.menu.addItem(action)
        }
    }

    _destroyActions() {
        for (var item of this._actions) {
            item.destroy();
        }
    }

    _onLockClicked() {
        Util.spawn(['tails-screen-locker']);
    }

    _onSuspendClicked() {
        Util.spawn(['systemctl', 'suspend'])
    }

    _onRestartClicked() {
        Util.spawn(['sudo', '-n', 'reboot'])
    }

    _onPowerOffClicked() {
        Util.spawn(['sudo', '-n', 'poweroff'])
    }

    _onMenuOpen() {
        this._lockScreenAction.visible = !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
        // Ideally we would only have to hide the original actions in
        // the enable() method, but something keeps making the original
        // shutdown action visible, so we ensure it is hidden each time
        // the menu is opened.
        this._hideOrigActions();
    }

}

function init(metadata) {
    Lib.initTranslations(Me);
    return new Extension();
}
