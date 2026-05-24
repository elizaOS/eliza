import logging
from gettext import gettext
import gi
from typing import TYPE_CHECKING

from tailsgreeter.translatable_window import TranslatableWindow

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk  # NOQA: E402

if TYPE_CHECKING:
    from tailsgreeter.ui.settings_collection import GreeterSettingsCollection

_ = gettext

PREFERRED_WIDTH = 400


class AddSettingsDialog(Gtk.Dialog, TranslatableWindow):
    def __init__(self, builder, settings: "GreeterSettingsCollection"):
        Gtk.Dialog.__init__(self, use_header_bar=True)
        TranslatableWindow.__init__(self, self)
        self.settings = settings
        self.listbox = builder.get_object("listbox_add_setting")

        for setting in self.settings.additional_settings:
            logging.debug("Adding '%s' to additional settings listbox", setting.name)
            self.listbox.add(setting.listboxrow)

        self.set_transient_for(self)
        self.set_title(_("Additional Settings"))
        self.set_default_size(-1, PREFERRED_WIDTH)

        sizegroup = Gtk.SizeGroup(Gtk.SizeGroupMode.HORIZONTAL)

        accelgroup = Gtk.AccelGroup()
        self.add_accel_group(accelgroup)

        self.button_cancel = self.add_button(_("Cancel"), Gtk.ResponseType.CANCEL)
        accelgroup.connect(Gdk.KEY_Escape, 0, 0, self.cb_accelgroup_cancel_activated)
        sizegroup.add_widget(self.button_cancel)

        self.button_add = self.add_button(_("Add"), Gtk.ResponseType.YES)
        Gtk.StyleContext.add_class(
            self.button_add.get_style_context(), "suggested-action"
        )
        sizegroup.add_widget(self.button_add)
        accelgroup.connect(Gdk.KEY_Return, 0, 0, self.cb_accelgroup_add_activated)
        self.button_add.set_visible(False)

        self.button_back = Gtk.Button.new_with_label(_("Back"))
        self.button_back.set_visible(False)
        self.button_back.connect("clicked", self.cb_button_back_clicked, None)
        sizegroup.add_widget(self.button_back)
        accelgroup.connect(Gdk.KEY_Back, 0, 0, self.cb_accelgroup_back_activated)
        # These key bindings are copied from Firefox, and are the same with
        # right-to-left languages.
        accelgroup.connect(
            Gdk.KEY_Left,
            Gdk.ModifierType.MOD1_MASK,
            0,
            self.cb_accelgroup_back_activated,
        )
        accelgroup.connect(
            Gdk.KEY_KP_Left,
            Gdk.ModifierType.MOD1_MASK,
            0,
            self.cb_accelgroup_back_activated,
        )
        self.get_header_bar().pack_end(self.button_back)

        self.stack = Gtk.Stack()
        self.stack.add_named(self.listbox, "setting-type")
        self.listbox.set_valign(Gtk.Align.FILL)
        self.listbox.set_vexpand(True)
        self.stack.set_visible(True)
        # XXX: is SLIDE_LEFT_RIGHT automatically inversed in RTL mode?
        self.stack.set_transition_type(Gtk.StackTransitionType.SLIDE_LEFT_RIGHT)
        self.get_content_area().add(self.stack)

        # Store translations
        self.store_translations(self)
        for setting in self.settings.additional_settings:
            self.store_translations(setting.box)

    def go_back(self):
        self.stack.set_visible_child_name("setting-type")
        self.button_back.set_visible(False)
        self.button_add.set_visible(False)
        self.stack.remove(self.stack.get_child_by_name("setting-details"))

    def listbox_focus(self):
        # Workaround autoselection of 1st item on focus
        self.listbox.unselect_all()

    def listbox_row_activated(self, row) -> bool:
        if not row:  # this happens when the row gets unselected
            return False

        # Show the selected setting
        id_ = self.settings.id_from_row(row)
        setting = self.settings.additional_settings[id_]
        self.stack.add_named(setting.box, "setting-details")
        self.stack.set_visible_child_name("setting-details")
        self.button_back.set_visible(True)
        self.button_add.set_sensitive(not setting.hide_button_add)
        self.button_add.set_visible(not setting.hide_button_add)
        setting.on_opened_in_dialog()

        return True

    def run(self, id_=None) -> int:
        # Set the dialog attribute for the additional settings.
        # This is required in order to allow the interactions with the
        # setting's UI elements to change the dialog UI elements, for
        # example the sensitivity of the "Add" button.
        for setting in self.settings.additional_settings:
            setting.dialog = self

        if id_:
            row = self.settings[id_].listboxrow
            row.emit("activate")
        else:
            self.stack.set_visible_child_name("setting-type")
            self.button_back.set_visible(False)
            self.button_add.set_visible(False)
        return super().run()

    def cb_accelgroup_add_activated(
        self, accel_group, accelerable, keyval, modifier, user_data=None
    ):
        if self.button_add.get_visible() and self.button_add.get_sensitive():
            self.response(Gtk.ResponseType.YES)
        return False

    def cb_accelgroup_back_activated(
        self, accel_group, accelerable, keyval, modifier, user_data=None
    ):
        self.go_back()
        return False

    def cb_accelgroup_cancel_activated(
        self, accel_group, accelerable, keyval, modifier, user_data=None
    ):
        self.response(Gtk.ResponseType.CANCEL)
        return True  # disable the default callbacks that destroys the dialog

    def cb_button_back_clicked(self, widget, user_data=None):
        self.go_back()
        return False
