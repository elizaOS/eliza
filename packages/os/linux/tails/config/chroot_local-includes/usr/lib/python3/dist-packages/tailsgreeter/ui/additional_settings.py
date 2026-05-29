import gi

from tailsgreeter import TRANSLATION_DOMAIN
import tailsgreeter.config
from tailsgreeter.settings import SettingNotFoundError
from tailsgreeter.ui import _
from tailsgreeter.ui.setting import GreeterSetting
from tailsgreeter.ui.popover import Popover
from typing import TYPE_CHECKING

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk  # NOQA: E402

if TYPE_CHECKING:
    from tailsgreeter.settings.admin import AdminSetting
    from tailsgreeter.settings.macspoof import MacSpoofSetting
    from tailsgreeter.settings.network import NetworkSetting

ADDITIONAL_SETTINGS_UI_FILE = "additional_settings.ui"


class AdditionalSetting(GreeterSetting):
    def __init__(self):
        super().__init__()
        self.dialog = None
        self.hide_button_add = False

        self.builder = Gtk.Builder()
        self.builder.set_translation_domain(TRANSLATION_DOMAIN)
        self.builder.add_from_file(
            tailsgreeter.config.data_path + ADDITIONAL_SETTINGS_UI_FILE
        )
        self.box = self.builder.get_object(f"box_{self.name}_popover")

    def build_popover(self):
        self.popover = Popover(self.listboxrow, self.box)

    def close_window(self, response: Gtk.ResponseType):
        if self.has_popover() and self.popover.is_open():
            self.popover.close(response)
        else:
            self.dialog.response(response)

    def on_opened_in_dialog(self):
        pass

    def load(self) -> bool:
        pass

    def cb_listbox_button_press(self, widget, event, user_data=None):
        # On double-click: Close the window and apply chosen setting
        if event.type == Gdk.EventType._2BUTTON_PRESS:  # NOQA: SLF001
            self.close_window(Gtk.ResponseType.YES)
        return False


class AdminSettingUI(AdditionalSetting):
    @property
    def name(self) -> str:
        return "admin"

    @property
    def title(self) -> str:
        return _("_Administration Password")

    @property
    def icon_name(self) -> str:
        return "tails-admin"

    @property
    def value_for_display(self) -> str:
        return get_on_off_string(
            self.new_password or self.use_saved_password, default=None
        )

    def update_check_icon(self):
        password = self.password_entry.get_text()
        password_verify = self.password_verify_entry.get_text()
        if not password_verify:
            icon = None
        elif password_verify == password:
            icon = "object-select-symbolic"
        else:
            icon = "dialog-warning-symbolic"
        self.password_verify_entry.set_icon_from_icon_name(
            Gtk.EntryIconPosition.SECONDARY, icon
        )

    def on_opened_in_dialog(self):
        self.update_check_icon()
        self.dialog.button_add.set_sensitive(self.passwords_match())
        self.password_entry.grab_focus()

    def __init__(self, admin_setting: "AdminSetting"):
        self._admin_setting = admin_setting
        self.new_password = ""
        self.use_saved_password = False
        super().__init__()
        self.accel_key = Gdk.KEY_a

        self.password_entry = self.builder.get_object("entry_admin_password")
        self.password_entry.connect("changed", self.cb_entry_admin_changed)
        self.password_entry.connect("activate", self.cb_entry_admin_activate)
        self.password_verify_entry = self.builder.get_object("entry_admin_verify")
        self.password_verify_entry.connect("changed", self.cb_entry_admin_changed)
        self.password_verify_entry.connect("activate", self.cb_entry_admin_activate)
        self.box_admin_password = self.builder.get_object("box_admin_password")
        self.box_admin_verify = self.builder.get_object("box_admin_verify")
        self.button_admin_disable = self.builder.get_object("button_admin_disable")
        self.button_admin_disable.connect(
            "clicked", self.cb_button_admin_disable_clicked
        )

    def build_popover(self):
        super().build_popover()
        self.popover.opened_cb = self.cb_popover_opened

    def cb_popover_opened(self, popover, user_data=None):
        self.password_verify_entry.set_icon_from_icon_name(
            Gtk.EntryIconPosition.SECONDARY, None
        )
        password_already_set = bool(self.new_password) or self.use_saved_password
        self.box_admin_password.set_visible(not password_already_set)
        self.box_admin_verify.set_visible(not password_already_set)
        self.button_admin_disable.set_visible(password_already_set)

    def passwords_match(self) -> bool:
        password = self.password_entry.get_text()
        # Don't accept an empty password
        if not password:
            return False
        return password == self.password_verify_entry.get_text()

    def apply(self):
        if self.use_saved_password:
            # This should only be the case if the persistent storage was
            # unlocked and a persistent password settings file was found.
            # In that case, we just want to keep the existing settings file.
            pass
        elif self.new_password:
            # Write the password to a file from which it will be set
            # as the amnesia password when the greeter is closed.
            self._admin_setting.save(self.new_password)
        else:
            self._admin_setting.delete()
        super().apply()

    def load(self) -> bool:
        try:
            self._admin_setting.load()
        except SettingNotFoundError:
            raise
        self.use_saved_password = True
        return True

    def cb_entry_admin_changed(self, editable, user_data=None):
        self.update_check_icon()
        passwords_match = self.passwords_match()
        if passwords_match:
            self.new_password = self.password_entry.get_text()
            self.use_saved_password = False
        if self.dialog:
            self.dialog.button_add.set_sensitive(passwords_match)
        return False

    def cb_entry_admin_activate(self, widget, user_data=None):
        if not self.passwords_match():
            if self.dialog:
                self.dialog.button_add.set_sensitive(False)
            self.password_verify_entry.grab_focus()
            return False

        self.new_password = self.password_entry.get_text()
        self.use_saved_password = False
        self.close_window(Gtk.ResponseType.YES)
        return False

    def cb_button_admin_disable_clicked(self, widget, user_data=None):
        self.new_password = None
        self.use_saved_password = False
        self.password_entry.set_text("")
        self.password_verify_entry.set_text("")

        if self.has_popover() and self.popover.is_open():
            self.popover.close(Gtk.ResponseType.YES)


class MACSpoofSettingUI(AdditionalSetting):
    @property
    def name(self) -> str:
        return "macspoof"

    @property
    def title(self) -> str:
        return _("_MAC Address Anonymization")

    @property
    def icon_name(self) -> str:
        return "tails-macspoof"

    @property
    def value_for_display(self) -> str:
        return get_on_off_string(self.spoofing_enabled, default=True)

    def __init__(self, macspoof_setting: "MacSpoofSetting"):
        self._macspoof_setting = macspoof_setting
        self.spoofing_enabled = True
        super().__init__()
        self.accel_key = Gdk.KEY_m

        self.image_macspoof_on = self.builder.get_object("image_macspoof_on")
        self.image_macspoof_off = self.builder.get_object("image_macspoof_off")
        self.listbox_macspoof_controls = self.builder.get_object(
            "listbox_macspoof_controls"
        )
        self.listbox_macspoof_controls.connect(
            "row-activated", self.cb_listbox_macspoof_row_activated
        )
        self.listbox_macspoof_controls.connect(
            "button-press-event", self.cb_listbox_button_press
        )
        self.listboxrow_macspoof_on = self.builder.get_object("listboxrow_macspoof_on")
        self.listboxrow_macspoof_off = self.builder.get_object(
            "listboxrow_macspoof_off"
        )

    def apply(self):
        self._macspoof_setting.save(self.spoofing_enabled)
        super().apply()

    def load(self) -> bool:
        try:
            value = self._macspoof_setting.load()
        except SettingNotFoundError:
            raise

        # Select the correct listboxrow (used in the popover)
        if value:
            self.listbox_macspoof_controls.select_row(self.listboxrow_macspoof_on)
        else:
            self.listbox_macspoof_controls.select_row(self.listboxrow_macspoof_off)

        if self.spoofing_enabled == value:
            return False

        self.spoofing_enabled = value
        return True

    def cb_listbox_macspoof_row_activated(self, listbox, row, user_data=None):
        self.spoofing_enabled = row == self.listboxrow_macspoof_on
        self.image_macspoof_on.set_visible(self.spoofing_enabled)
        self.image_macspoof_off.set_visible(not self.spoofing_enabled)

        if self.has_popover() and self.popover.is_open():
            self.popover.close(Gtk.ResponseType.YES)
        return False


class NetworkSettingUI(AdditionalSetting):
    @property
    def name(self) -> str:
        return "network"

    @property
    def title(self) -> str:
        return _("_Offline Mode")

    @property
    def icon_name(self) -> str:
        return "airplane-mode-symbolic"

    @property
    def value_for_display(self) -> str:
        if self.network_enabled:
            return _("Enable networking (default)")
        else:
            return _("Disable all networking")

    def __init__(self, network_setting: "NetworkSetting"):
        self._network_setting = network_setting
        self.network_enabled = True
        super().__init__()
        self.accel_key = Gdk.KEY_o

        self.image_network_on = self.builder.get_object("image_network_on")
        self.image_network_off = self.builder.get_object("image_network_off")
        self.listbox_network_controls = self.builder.get_object(
            "listbox_network_controls"
        )
        self.listbox_network_controls.connect(
            "row-activated", self.cb_listbox_network_row_activated
        )
        self.listbox_network_controls.connect(
            "button-press-event", self.cb_listbox_button_press
        )
        self.listboxrow_network_on = self.builder.get_object("listboxrow_network_on")
        self.listboxrow_network_off = self.builder.get_object("listboxrow_network_off")

    def apply(self):
        self._network_setting.save(self.network_enabled)
        super().apply()

    def load(self) -> bool:
        try:
            value = self._network_setting.load()
        except SettingNotFoundError:
            raise

        # Select the correct listboxrow (used in the popover)
        if value:
            self.listbox_network_controls.select_row(self.listboxrow_network_on)
        else:
            self.listbox_network_controls.select_row(self.listboxrow_network_off)

        if self.network_enabled == value:
            return False

        self.network_enabled = value
        return True

    def cb_listbox_network_row_activated(self, listbox, row, user_data=None):
        self.network_enabled = row == self.listboxrow_network_on
        self.image_network_on.set_visible(self.network_enabled)
        self.image_network_off.set_visible(not self.network_enabled)

        if self.has_popover() and self.popover.is_open():
            self.popover.close(Gtk.ResponseType.YES)
        return False


class UnsafeBrowserSettingUI(AdditionalSetting):
    @property
    def name(self) -> str:
        return "unsafe_browser"

    @property
    def title(self) -> str:
        return _("_Unsafe Browser")

    @property
    def icon_name(self) -> str:
        return "dialog-warning-symbolic"

    @property
    def value_for_display(self) -> str:
        if self.unsafe_browser_enabled:
            return _("Enabled (default)")
        else:
            return _("Disabled")

    def __init__(self, unsafe_browser_setting):
        self._unsafe_browser_setting = unsafe_browser_setting
        self.unsafe_browser_enabled = True
        super().__init__()
        self.accel_key = Gdk.KEY_u
        self.listbox_unsafe_browser_controls = self.builder.get_object(
            "listbox_unsafe_browser_controls"
        )
        self.listbox_unsafe_browser_controls.connect(
            "button-press-event", self.cb_listbox_button_press
        )
        self.listbox_unsafe_browser_controls.connect(
            "row-activated", self.cb_listbox_unsafe_browser_row_activated
        )
        self.listboxrow_unsafe_browser_off = self.builder.get_object(
            "listboxrow_unsafe_browser_off"
        )
        self.listboxrow_unsafe_browser_on = self.builder.get_object(
            "listboxrow_unsafe_browser_on"
        )
        self.icon_unsafe_browser_off = self.builder.get_object(
            "image_unsafe_browser_off"
        )
        self.icon_unsafe_browser_on = self.builder.get_object("image_unsafe_browser_on")
        self.label_unsafe_browser_value = self.builder.get_object(
            "label_unsafe_browser_value"
        )

    def apply(self):
        self._unsafe_browser_setting.save(self.unsafe_browser_enabled)
        super().apply()

    def load(self) -> bool:
        try:
            value = self._unsafe_browser_setting.load()
        except SettingNotFoundError:
            raise

        # Select the correct listboxrow (used in the popover)
        if value:
            self.listbox_unsafe_browser_controls.select_row(
                self.listboxrow_unsafe_browser_on
            )
        else:
            self.listbox_unsafe_browser_controls.select_row(
                self.listboxrow_unsafe_browser_off
            )

        if self.unsafe_browser_enabled == value:
            return False

        self.unsafe_browser_enabled = value
        return True

    def cb_listbox_unsafe_browser_row_activated(self, listbox, row, user_data=None):
        self.unsafe_browser_enabled = row == self.listboxrow_unsafe_browser_on
        self.icon_unsafe_browser_on.set_visible(self.unsafe_browser_enabled)
        self.icon_unsafe_browser_off.set_visible(not self.unsafe_browser_enabled)

        if self.has_popover() and self.popover.is_open():
            self.popover.close(Gtk.ResponseType.YES)
        return False


def get_on_off_string(value, default=None) -> str:
    """Return "On", "Off", "On (default)", or "Off (default)"""
    if value and default:
        return _("On (default)")
    if value and not default:
        return _("On")
    if not value and default:
        return _("Off")
    if not value and not default:
        return _("Off (default)")
    else:
        raise NotImplementedError
