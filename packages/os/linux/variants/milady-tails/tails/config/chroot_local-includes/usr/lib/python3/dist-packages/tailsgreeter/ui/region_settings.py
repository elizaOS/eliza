import logging
import gi
from collections.abc import Callable

from tailsgreeter import TRANSLATION_DOMAIN
import tailsgreeter.config
from tailsgreeter.settings import SettingNotFoundError
from tailsgreeter.settings.formats import FormatsSetting
from tailsgreeter.settings.keyboard import KeyboardSetting
from tailsgreeter.settings.language import LanguageSetting
from tailsgreeter.settings.localization import LocalizationSetting
from tailsgreeter.ui import _
from tailsgreeter.ui.setting import GreeterSetting
from tailsgreeter.ui.popover import Popover

gi.require_version("Gtk", "3.0")
gi.require_version("Pango", "1.0")
from gi.repository import Gtk, Pango  # NOQA: E402


REGION_SETTINGS_UI_FILE = "region_settings.ui"


class LocalizationSettingUI(GreeterSetting):
    def __init__(self, localization_setting: LocalizationSetting):
        self._setting = localization_setting
        self.value: str | None = self.default
        self.value_changed_by_user = False
        super().__init__()

        self._setting.connect("notify::value", self.cb_value_changed)

        self.treestore = self._setting.get_tree()

        self.builder = Gtk.Builder()
        self.builder.set_translation_domain(TRANSLATION_DOMAIN)
        self.builder.add_from_file(
            tailsgreeter.config.data_path + REGION_SETTINGS_UI_FILE
        )
        popover_box = self.builder.get_object(f"box_{self.name}_popover")
        self.popover = Popover(self.listboxrow, popover_box)

        self.treeview = self.builder.get_object(f"treeview_{self.name}")
        self.treeview.connect("row-activated", self.cb_treeview_row_activated)

        # Fill the treeview
        renderer = Gtk.CellRendererText()
        renderer.props.ellipsize = Pango.EllipsizeMode.END
        column = Gtk.TreeViewColumn("", renderer, text=1)
        self.treeview.append_column(column)

        searchentry = self.builder.get_object(f"searchentry_{self.name}")
        searchentry.connect("search-changed", self.cb_searchentry_search_changed)
        searchentry.connect("activate", self.cb_searchentry_activate)

        self.treestore_filtered = self.treestore.filter_new()
        self.treestore_filtered.set_visible_func(
            self.cb_liststore_filtered_visible_func, data=searchentry
        )
        self.treeview.set_model(self.treestore_filtered)

    def apply(self):
        self._setting.save(self.value, is_default=False)
        super().apply()

    def load(self) -> bool:
        try:
            value, is_default = self._setting.load()
        except SettingNotFoundError:
            raise

        if value == self.value:
            return False

        self.value = value
        self.value_changed_by_user = not is_default
        self.apply()
        return True

    @property
    def default(self) -> str | None:
        return None

    def on_language_changed(self, locale: str):
        pass

    def cb_searchentry_activate(self, searchentry, user_data=None):
        """Selects the topmost item in the treeview when pressing Enter"""
        if searchentry.get_text():
            self.treeview.row_activated(
                Gtk.TreePath.new_from_string("0"), self.treeview.get_column(0)
            )
        else:
            self.popover.close(Gtk.ResponseType.CANCEL)

    def cb_searchentry_search_changed(self, searchentry, user_data=None):
        self.treestore_filtered.refilter()
        if searchentry.get_text():
            self.treeview.expand_all()
            self.treeview.scroll_to_point(0, 0)  # scroll to top
        else:
            self.treeview.collapse_all()
        return False

    def cb_treeview_row_activated(self, treeview, path, column, user_data=None):
        treemodel = treeview.get_model()
        self.value = treemodel.get_value(treemodel.get_iter(path), 0)
        self.value_changed_by_user = True
        self.popover.close(Gtk.ResponseType.YES)

    def cb_value_changed(self, obj, param):
        logging.debug(f"refreshing {self._setting.get_name(self.value)}")

        def treeview_select_line(model, path, iter_, data):
            if model.get_value(iter_, 0) == data:
                self.treeview.get_selection().select_iter(iter_)
                self.treeview.scroll_to_cell(path, use_align=True, row_align=0.5)
                return True
            else:
                return False

        self.treestore_filtered.foreach(treeview_select_line, self._setting.value)

    def cb_liststore_filtered_visible_func(self, model, treeiter, searchentry):
        search_stings = searchentry.get_text().lower().split()
        if not search_stings:
            return True

        return all(
            self.node_visible_func(model, treeiter, search_string)
            for search_string in search_stings
        )

    def node_visible_func(self, model, treeiter, search_string):
        """Returns True if the node itself or the parent node or any of the
        children nodes match the search string"""

        # Check if the node is a top-level node
        treepath = model.get_path(treeiter)
        is_top_level_node = treepath.get_depth() == 1

        # Does the node itself match the search?
        if self.node_matches_string(model, treeiter, search_string):
            return True

        if not is_top_level_node:
            # Does the parent node match the search?
            parent_treepath = treepath.copy()
            parent_treepath.up()
            if parent_treepath.get_depth() == 1:
                # treepath is now the parent
                parent_treeiter = model.get_iter(parent_treepath)
                # Only check the name of the parent node, not the language
                # code, because we don't want to show all children if the
                # search string matches the default language code (which is
                # the language code of the parent node).
                return self.node_matches_string(
                    model, parent_treeiter, search_string, only_check_name=True
                )

        # Does any of the children nodes match the search?
        children_treeiter = model.iter_children(treeiter)
        while children_treeiter:
            if self.node_matches_string(model, children_treeiter, search_string):
                return True
            children_treeiter = model.iter_next(children_treeiter)

        return False

    def node_matches_string(self, model, node, search_string, only_check_name=False):
        """Returns True if any of the columns of the node match the search
        string"""
        if only_check_name:
            return search_string in model.get_value(node, 1).lower()

        return any(
            search_string in model.get_value(node, i).lower()
            for i in range(model.get_n_columns())
        )


class LanguageSettingUI(LocalizationSettingUI):
    _setting: LanguageSetting = None

    @property
    def name(self) -> str:
        return "language"

    @property
    def title(self) -> str:
        return _("_Language")

    @property
    def icon_name(self):
        return "tails-language"

    @property
    def value_for_display(self) -> str:
        return self._setting.get_name(self.value)

    @property
    def default(self) -> str:
        return "en_US"

    def __init__(self, setting: LanguageSetting, changed_cb: Callable):
        self.changed_cb = changed_cb
        super().__init__(setting)

    def apply(self):
        super().apply()
        self._setting.apply_language(self.value)
        self.changed_cb(self.value)

    def load(self) -> bool:
        try:
            changed = super().load()
        except SettingNotFoundError:
            raise
        if changed:
            self._setting.apply_language(self.value)
            self.changed_cb(self.value)
        return changed


class FormatsSettingUI(LocalizationSettingUI):
    _setting: FormatsSetting = None

    @property
    def name(self) -> str:
        return "formats"

    @property
    def title(self) -> str:
        return _("_Formats")

    @property
    def icon_name(self):
        return "tails-formats"

    @property
    def value_for_display(self) -> str:
        return self._setting.get_name(self.value)

    @property
    def default(self) -> str:
        return "en_US"

    def on_language_changed(self, locale: str):
        """Set the formats according to the new language"""
        # Don't overwrite user chosen values
        if self.value_changed_by_user:
            return

        if self.value == locale:
            return

        self.value = locale
        self.update_value_label()
        self._setting.save(locale, is_default=True)


class KeyboardSettingUI(LocalizationSettingUI):
    _setting: KeyboardSetting = None

    @property
    def name(self) -> str:
        return "keyboard"

    @property
    def title(self) -> str:
        return _("_Keyboard Layout")

    @property
    def icon_name(self):
        return "tails-keyboard-layout"

    @property
    def value_for_display(self) -> str:
        return self._setting.get_name(self.value)

    @property
    def default(self) -> str:
        return "us"

    def apply(self):
        super().apply()
        self._setting.apply_layout_to_current_screen(self.value)

    def on_language_changed(self, locale: str):
        """Set the keyboard layout according to the new language"""

        # Don't overwrite a user chosen value
        if self.value_changed_by_user:
            return

        layout = self._setting.get_layout_for_locale(locale)
        if self.value == layout:
            return

        self.value = layout
        self.update_value_label()
        self._setting.save(layout, is_default=True)
        self._setting.apply_layout_to_current_screen(self.value)
