/**********************************************************************
Tor Status: a GNOME shell extension to display Tor status
Copyright (C) 2015 Tails Developers <foundations@tails.net>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
**********************************************************************/

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Gettext from 'gettext';
Gettext.textdomain('tails');
const _ = Gettext.gettext;

const TorStatusIndicatorName = 'tor-status';
const TorStatusIndicatorStatusFile = '/run/tor-has-bootstrapped/done';

var TorStatusIndicator = GObject.registerClass(
class TorStatusIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _("Tor Status"));

        // Monitor the status file
        let status_file = Gio.File.new_for_path(TorStatusIndicatorStatusFile);
        this._status_file_monitor = status_file.monitor(Gio.FileMonitorFlags.NONE, null);
        this._monitor_changed_signal_id = this._status_file_monitor.connect(
            'changed', this._onFileChanged.bind(this));

        // Create menu
        this.tca_menu_item = new PopupMenu.PopupMenuItem(_("Open Tor Connection Assistant"));
        this.tca_menu_item.connect('activate', this._openTca.bind(this));
        this.menu.addMenuItem(this.tca_menu_item);

        this.menu_item = new PopupMenu.PopupMenuItem(_("View Tor Circuits"));
        this.menu_item.connect('activate', this._openOnionCircuits.bind(this));
        this.menu.addMenuItem(this.menu_item);

        // Create icon
        this._icon = new St.Icon({ style_class: 'system-status-icon' });
        this._updateIcon(status_file.query_exists(null));
        this.add_child(this._icon);
        this.add_style_class_name('panel-status-button');
    }

    _updateIcon(tor_is_connected) {
        this.menu_item.setSensitive(tor_is_connected);
        if (tor_is_connected) {
            this._icon.set_icon_name('tor-connected-symbolic');
        } else {
            this._icon.set_icon_name('tor-disconnected-symbolic');
        }
    }

    _openOnionCircuits() {
        Shell.AppSystem.get_default().lookup_app('onioncircuits.desktop').activate();
    }

    _openTca() {
        Shell.AppSystem.get_default().lookup_app('tca.desktop').activate();
    }

    _onFileChanged(monitor, file, other_file, event_type, user_data) {
        switch (event_type) {
            case Gio.FileMonitorEvent.CREATED:
                this._updateIcon(true);
                break;
            case Gio.FileMonitorEvent.DELETED:
                this._updateIcon(false);
                break;
        }
    }

    destroy() {
        log("TorStatus: entering destroy()");
        if (this._status_file_monitor) {
            this._status_file_monitor.disconnect(this._monitor_changed_signal_id);
            this._status_file_monitor = 0;
        }

        super.destroy();
        log("TorStatus: exiting destroy()");
    }
});

export default class TorStatusExtension {

    init() {
    }

    enable() {
        log("TorStatus: entering enable()");
        this.tor_status_indicator = new TorStatusIndicator;
        Main.panel.addToStatusArea(TorStatusIndicatorName, this.tor_status_indicator);
        log("TorStatus: exiting enable()");
    }

    disable() {
        log("TorStatus: entering disable()");
        this.tor_status_indicator.destroy();
        log("TorStatus: exiting disable()");
    }

}
