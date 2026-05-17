import datetime
from typing import Optional
from logging import getLogger
from collections import defaultdict

import pytz
import gi

from tailsgreeter.ui.popover import Popover
import tca.config
import tailslib.release

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
gi.require_version("GLib", "2.0")
gi.require_version("Pango", "1.0")

from gi.repository import Gdk, GdkPixbuf, Gtk, GLib, Pango  # noqa: E402

log = getLogger("dialogs")


def get_release_year():
    return tailslib.release.get_release_date().year


def get_time_dialog(initial_tz: str | None = None):
    """Create a TimeDialog."""
    builder = Gtk.Builder()
    builder.set_translation_domain("tails")
    builder.add_from_file(tca.config.data_path + "time-dialog.ui")
    time_dialog = builder.get_object("dialog")  # noqa: N806
    if initial_tz:
        builder.get_object("listbox_tz_label_value").set_text(initial_tz)
    popover = TimezonePopover(builder, builder.get_object("listbox_tz_label_value"))
    DEFAULT_TIMEZONE = "UTC (Greenwich time)"

    def get_tz_name(_=None):
        return builder.get_object("listbox_tz_label_value").get_text()
        # return tz_model.get_value(select_tz.get_active_iter(), 0)

    def get_date(_=None):
        spec = {
            part: int(builder.get_object(part).get_value())
            for part in ["hour", "minute", "day", "year"]
        }
        spec["month"] = int(builder.get_object("select_month").get_active_id())
        naive_dt = datetime.datetime(**spec)
        tz_name = get_tz_name()
        if tz_name == DEFAULT_TIMEZONE:
            tz_name = "UTC"
        tz = pytz.timezone(tz_name)
        aware_dt = tz.localize(naive_dt)
        return aware_dt

    def cb_listbox_tz_clicked(*args):
        def on_close(popover, tzpopover):
            if tzpopover.value_changed_by_user:
                builder.get_object("listbox_tz_label_value").set_text(tzpopover.value)
            check_input_valid()

        popover.popover.open(on_close, popover)

    time_dialog.get_date = get_date
    time_dialog.get_tz_name = get_tz_name

    def check_input_valid(*args):
        """
        Check if user input is valid.

        Let Apply be sensitive accordingly
        """

        def is_valid():
            if not time_dialog.get_tz_name():
                return False
            try:
                # checks if the date is correct (ie: what about February 31?)
                get_date()
            except ValueError:
                return False
            return True

        builder.get_object("btn_apply").set_sensitive(is_valid())
        return

    now = datetime.datetime.now()
    builder.get_object("hour").set_range(0, 23)
    builder.get_object("hour").set_value(now.hour)
    builder.get_object("minute").set_range(0, 59)
    builder.get_object("minute").set_value(now.minute)
    builder.get_object("day").set_range(1, 31)
    builder.get_object("day").set_value(now.day)
    min_year = get_release_year()
    max_year = max(now.year, min_year + 10)
    builder.get_object("year").set_range(min_year, max_year)
    builder.get_object("year").set_value(now.year)

    builder.get_object("select_month").set_active_id(str(now.month))

    for spin in ["hour", "minute", "day", "year"]:
        builder.get_object(spin).set_numeric(True)
        builder.get_object(spin).set_increments(1, 6)

    for obj in ["hour", "minute", "day", "year", "select_month"]:
        builder.get_object(obj).connect("changed", check_input_valid)

    builder.get_object("btn_cancel").connect(
        "clicked", lambda *_: time_dialog.response(Gtk.ResponseType.CANCEL)
    )
    builder.get_object("btn_apply").connect(
        "clicked", lambda *_: time_dialog.response(Gtk.ResponseType.APPLY)
    )

    builder.get_object("listbox_tz").connect("row-activated", cb_listbox_tz_clicked)

    return time_dialog


class TimezonePopover:
    def _create_tz_store(self) -> Gtk.TreeStore:
        self.treestore = Gtk.TreeStore(str)
        timezones = pytz.common_timezones
        timezone_tree: dict[str, list[str]] = defaultdict(list)
        toplevel_timezones: list[str] = []
        for tz in timezones:
            if "/" not in tz:  # GMT and UTC
                toplevel_timezones.append(tz)
            else:  # everything else
                region, city = tz.split("/", 1)
                timezone_tree[region].append(tz)

        for region in sorted(timezone_tree):
            regioniter = self.treestore.append(parent=None, row=[region])
            for city in sorted(timezone_tree[region]):
                self.treestore.append(parent=regioniter, row=[city])

        for tz in toplevel_timezones:
            self.treestore.append(parent=None, row=[tz])

    def __init__(self, builder, relative_to):
        self.id = "tz"
        self.builder = builder
        self.relative_to = relative_to
        self._create_tz_store()
        self.value_changed_by_user = False
        popover_box = self.builder.get_object(f"box_{self.id}_popover")
        self.popover = Popover(self.relative_to, popover_box)
        self.popover.widget.set_constrain_to(Gtk.PopoverConstraint.NONE)
        self.popover.widget.set_position(Gtk.PositionType.RIGHT)

        self.treeview = self.builder.get_object(f"treeview_{self.id}")
        self.treeview.connect("row-activated", self.cb_treeview_row_activated)

        # Fill the treeview
        renderer = Gtk.CellRendererText()
        renderer.props.ellipsize = Pango.EllipsizeMode.END
        column = Gtk.TreeViewColumn("", renderer, text=0)
        self.treeview.append_column(column)

        searchentry = self.builder.get_object(f"searchentry_{self.id}")
        searchentry.connect("search-changed", self.cb_searchentry_search_changed)
        searchentry.connect("activate", self.cb_searchentry_activate)

        self.treestore_filtered = self.treestore.filter_new()
        self.treestore_filtered.set_visible_func(
            self.cb_liststore_filtered_visible_func, data=searchentry
        )
        self.treeview.set_model(self.treestore_filtered)

    def cb_searchentry_activate(self, searchentry, user_data=None) -> None:
        """Select the topmost item in the treeview when pressing Enter."""
        if not searchentry.get_text():
            self.popover.close(Gtk.ResponseType.CANCEL)
            return

        store = self.treestore_filtered
        first_item_iter: Gtk.TreeIter = store.get_iter_first()

        if first_item_iter is None:  # store is empty
            return

        # Right now, this is always true. But if we add UTC again,
        # then this could fail, so let's have this check
        if store.iter_has_child(first_item_iter):
            first_item_iter = store.iter_nth_child(first_item_iter, 0)

        first_item_path: Gtk.TreePath = store.get_path(first_item_iter)
        self.treeview.row_activated(first_item_path, self.treeview.get_column(0))

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
        treeiter = treemodel.get_iter(path)
        if treemodel.iter_parent(treeiter) is None:  # is top-level
            if (
                treemodel.iter_children(treeiter) is not None
            ):  # has children: it is a region
                # user cannot select a parent node like "Europe",
                # because that's not a timezone
                # XXX: expand/collapse this row would probably be better UX
                return
        self.value = treemodel.get_value(treeiter, 0)
        self.value_changed_by_user = True
        self.popover.close(Gtk.ResponseType.YES)

    def cb_liststore_filtered_visible_func(self, model, treeiter, searchentry):
        search_query = searchentry.get_text().replace(" ", "_").lower()
        value = model.get_value(treeiter, 0)

        def matcher(v: str):
            return search_query in v.lower()

        if not search_query:  # display everything
            return True

        # Does the current node match the search?
        if matcher(value):
            return True

        # Does the parent node match the search?
        #   In theory that's important; but since we're matching against
        #   the whole timezone, which includes
        #   the name of the parent, that's already covered

        # Does any of the children nodes match the search?
        children_treeiter = model.iter_children(treeiter)
        while children_treeiter is not None:
            child_value = model.get_value(children_treeiter, 0)
            if matcher(child_value):
                return True
            children_treeiter = model.iter_next(children_treeiter)

        return False
